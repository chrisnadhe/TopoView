"""
Network config parser for Cisco IOS and Juniper JunOS.
Extracts: hostname, interfaces, IP addresses, descriptions, and infers links.
"""

import re
import ipaddress
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Interface:
    name: str
    ip_address: Optional[str] = None
    subnet: Optional[str] = None
    description: Optional[str] = None
    status: str = "up"  # up / down / unknown
    nameif: Optional[str] = None      # ASA-specific zone
    security_level: Optional[int] = None


@dataclass
class Device:
    hostname: str
    vendor: str  # "cisco" | "juniper" | "unknown"
    device_type: str  # "router" | "switch" | "firewall" | "unknown"
    interfaces: list[Interface] = field(default_factory=list)
    filename: str = ""


def detect_vendor(content: str) -> str:
    if re.search(r"^hostname\s+", content, re.MULTILINE):
        return "cisco"
    if re.search(r"^system\s*\{", content, re.MULTILINE):
        return "juniper"
    return "unknown"


def detect_device_type(hostname: str, content: str) -> str:
    h = hostname.lower()
    if any(k in h for k in ["fw", "asa", "firewall", "pix"]):
        return "firewall"
    if any(k in h for k in ["sw", "switch", "cat"]):
        return "switch"
    if any(k in h for k in ["r", "router", "rtr", "gw", "gateway"]):
        return "router"
    # fallback: check content
    if "nameif" in content or "security-level" in content:
        return "firewall"
    if "spanning-tree" in content or "vlan" in content.lower():
        return "switch"
    return "router"


def parse_cisco(content: str, filename: str = "") -> Device:
    hostname_match = re.search(r"^hostname\s+(\S+)", content, re.MULTILINE)
    hostname = hostname_match.group(1) if hostname_match else "Unknown"
    device_type = detect_device_type(hostname, content)

    # Split into interface blocks
    iface_pattern = re.compile(
        r"^interface\s+(\S.*?)\n(.*?)(?=^interface\s|\Z)",
        re.MULTILINE | re.DOTALL
    )
    interfaces = []
    for m in iface_pattern.finditer(content):
        iface_name = m.group(1).strip()
        block = m.group(2)

        # Skip loopback and tunnel interfaces
        if re.match(r"(Loopback|Tunnel|Null|Vlan)", iface_name, re.IGNORECASE):
            continue

        iface = Interface(name=iface_name)

        ip_m = re.search(r"ip address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)", block)
        if ip_m:
            iface.ip_address = ip_m.group(1)
            try:
                net = ipaddress.IPv4Network(f"{ip_m.group(1)}/{ip_m.group(2)}", strict=False)
                iface.subnet = str(net)
            except Exception:
                pass

        desc_m = re.search(r"description\s+(.+)", block)
        if desc_m:
            iface.description = desc_m.group(1).strip()

        nameif_m = re.search(r"nameif\s+(\S+)", block)
        if nameif_m:
            iface.nameif = nameif_m.group(1)

        sec_m = re.search(r"security-level\s+(\d+)", block)
        if sec_m:
            iface.security_level = int(sec_m.group(1))

        if re.search(r"shutdown", block) and not re.search(r"no shutdown", block):
            iface.status = "down"
        else:
            iface.status = "up"

        # Only include interfaces that have an IP or description
        if iface.ip_address or iface.description:
            interfaces.append(iface)

    return Device(
        hostname=hostname,
        vendor="cisco",
        device_type=device_type,
        interfaces=interfaces,
        filename=filename
    )


def parse_juniper(content: str, filename: str = "") -> Device:
    """Basic JunOS parser — extracts hostname and interface IPs."""
    hostname_m = re.search(r"host-name\s+(\S+)", content)
    hostname = hostname_m.group(1).rstrip(";") if hostname_m else "Unknown"
    device_type = detect_device_type(hostname, content)

    interfaces = []
    iface_blocks = re.finditer(
        r"(\S+)\s*\{[^}]*address\s+([\d./]+)[^}]*\}",
        content, re.DOTALL
    )
    for m in iface_blocks:
        iface_name = m.group(1)
        if any(k in iface_name.lower() for k in ["lo", "tunnel"]):
            continue
        try:
            net = ipaddress.IPv4Interface(m.group(2))
            iface = Interface(
                name=iface_name,
                ip_address=str(net.ip),
                subnet=str(net.network)
            )
            interfaces.append(iface)
        except Exception:
            pass

    return Device(
        hostname=hostname,
        vendor="juniper",
        device_type=device_type,
        interfaces=interfaces,
        filename=filename
    )


def parse_config(content: str, filename: str = "") -> Device:
    vendor = detect_vendor(content)
    if vendor == "cisco":
        return parse_cisco(content, filename)
    elif vendor == "juniper":
        return parse_juniper(content, filename)
    else:
        # Best-effort: try Cisco parser
        return parse_cisco(content, filename)


def infer_links(devices: list[Device]) -> list[dict]:
    """
    Match interfaces that share the same /30 or /24 subnet.
    Returns a list of link dicts: {source, target, source_iface, target_iface, subnet}
    """
    # Build: subnet -> [(device, interface)]
    subnet_map: dict[str, list[tuple[Device, Interface]]] = {}
    for dev in devices:
        for iface in dev.interfaces:
            if iface.subnet:
                subnet_map.setdefault(iface.subnet, []).append((dev, iface))

    links = []
    seen = set()
    for subnet, endpoints in subnet_map.items():
        if len(endpoints) < 2:
            continue
        for i in range(len(endpoints)):
            for j in range(i + 1, len(endpoints)):
                dev_a, iface_a = endpoints[i]
                dev_b, iface_b = endpoints[j]
                key = tuple(sorted([dev_a.hostname, dev_b.hostname, subnet]))
                if key in seen:
                    continue
                seen.add(key)
                links.append({
                    "source": dev_a.hostname,
                    "target": dev_b.hostname,
                    "source_iface": iface_a.name,
                    "target_iface": iface_b.name,
                    "source_ip": iface_a.ip_address,
                    "target_ip": iface_b.ip_address,
                    "subnet": subnet,
                })

    return links


def build_topology(devices: list[Device]) -> dict:
    """Convert parsed devices into D3-compatible nodes/links JSON."""
    nodes = []
    for dev in devices:
        nodes.append({
            "id": dev.hostname,
            "hostname": dev.hostname,
            "vendor": dev.vendor,
            "device_type": dev.device_type,
            "filename": dev.filename,
            "interfaces": [
                {
                    "name": i.name,
                    "ip": i.ip_address,
                    "subnet": i.subnet,
                    "description": i.description,
                    "status": i.status,
                    "nameif": i.nameif,
                    "security_level": i.security_level,
                }
                for i in dev.interfaces
            ]
        })

    links = infer_links(devices)

    return {"nodes": nodes, "links": links}