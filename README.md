# Network Topology Visualizer (TopoView)

Upload Cisco IOS / Juniper JunOS config files and get an interactive force-directed topology diagram — powered by FastAPI + D3.js.

## Project Structure

```
TopoView/
├── backend/
│   ├── main.py          ← FastAPI app & API routes
│   └── parser.py        ← Cisco / Juniper config parser (with CDP/LLDP support)
├── frontend/
│   ├── index.html       ← Single-page app (Tailwind CSS styled UI)
│   └── static/
│       └── js/
│           └── topology.js  ← D3.js visualizer & interaction logic
├── sample_configs/      ← Demo network configs with CDP/LLDP neighbors
├── pyproject.toml       ← Project dependencies & python metadata
├── uv.lock              ← uv Lockfile
└── README.md
```

## Quick Start

### 1. Install dependencies
Make sure you have [uv](https://github.com/astral-sh/uv) installed.
```bash
uv sync
```

### 2. Run the server
```bash
cd backend
uv run uvicorn main:app --reload --port 8000
```

### 3. Open in browser
```
http://localhost:8000
```

## Features

- **Multi-Vendor Configuration Upload**: Upload multiple Cisco IOS, Cisco ASA, and Juniper JunOS configuration files simultaneously.
- **Smart Device Classification**: Automatically detects vendor and device type (Router, Firewall, Switch, or Unknown) based on hostname syntax and configuration patterns.
- **CDP & LLDP Neighbor Parsing**: Automatically parses device neighbors from CLI outputs (e.g. `show cdp neighbors` / `show lldp neighbors`) if appended or included in the configuration files.
- **Intelligent Link Inference**:
  - Automatically establishes links using parsed **CDP/LLDP** topology maps.
  - Falls back to matching **shared subnets** (e.g. `/30` or `/24`) across device interfaces.
- **Interactive D3 Force-Directed Graph**:
  - Drag nodes to rearrange the layout (nodes pin in place when dragged; double-click a node to release/unpin).
  - Smooth pan and zoom capabilities.
- **Manual Link Editor**:
  - Click the chain-link icon in the toolbar to enter Edit Mode.
  - Click and drag between any two nodes to create a manual connection.
  - Prompted dialog allows custom source port, target port, and link label.
  - Right-click any link (manual or auto-discovered) to delete it directly from the topology.
- **Node Label & Annotation Editor**:
  - Double-click any node to rename its display label.
  - Add custom notes/annotations which render beneath the hostname with a 📝 icon.
- **Port Label Overlay**:
  - Interface names are dynamically drawn along the link lines (positioned at 20% and 80% marks along the path).
- **Device Details Panel**:
  - Click any node to view detailed metadata (interfaces, assigned IPs, subnets, descriptions, security zones, and user notes).
- **Export to SVG**: Download the current topology layout as a clean SVG vector graphic.
- **Demo Mode**: Built-in "Load Demo Network" button loads a pre-configured multi-device topology to test out all interactive features immediately.

## Supported Config Formats

| Vendor | Format | Parsed fields |
|--------|--------|---------------|
| Cisco IOS | `hostname`, `interface`, `ip address`, `description`, `shutdown`, `show cdp neighbors` | Host details, Interface table, Neighbors |
| Cisco ASA | Same + `nameif`, `security-level` | Host details, Interfaces, Security Zones |
| Juniper JunOS | `host-name`, interfaces, `show lldp neighbors` | Host details, Interfaces, Neighbors |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/parse` | Upload config files, returns parsed topology JSON |
| `POST` | `/api/parse-demo` | Loads sample configs from `sample_configs/` directory |
| `GET`  | `/api/health` | Health check |

## Topology JSON Format

The backend returns a clean, D3-compatible nodes and links schema:

```json
{
  "nodes": [
    {
      "id": "R1",
      "hostname": "R1",
      "vendor": "cisco",
      "device_type": "router",
      "filename": "R1.txt",
      "interfaces": [
        {
          "name": "GigabitEthernet0/0",
          "ip": "10.0.12.1",
          "subnet": "10.0.12.0/24",
          "description": "Link-to-R2",
          "status": "up",
          "nameif": null,
          "security_level": null
        }
      ]
    }
  ],
  "links": [
    {
      "source": "R1",
      "target": "R2",
      "source_iface": "GigabitEthernet0/0",
      "target_iface": "GigabitEthernet0/0",
      "source_ip": "10.0.12.1",
      "target_ip": "10.0.12.2",
      "subnet": "10.0.12.0/24",
      "link_type": "subnet" // can be "subnet" or "cdp"
    }
  ],
  "parse_errors": [],
  "file_count": 1
}
```

## Next Steps (roadmap)

- [ ] Live device polling via SSH (Netmiko)
- [ ] VLAN / routing protocol info overlay
- [ ] Save / load topology sessions
- [ ] Export to draw.io XML