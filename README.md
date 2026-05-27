# Network Topology Visualizer

Upload Cisco IOS / Juniper JunOS config files and get an interactive force-directed topology diagram — powered by FastAPI + D3.js.

## Project Structure

```
network-topology/
├── backend/
│   ├── main.py          ← FastAPI app & API routes
│   └── parser.py        ← Cisco / Juniper config parser
├── frontend/
│   ├── index.html       ← Single-page app
│   └── static/
│       ├── css/style.css
│       └── js/topology.js  ← D3.js visualizer
├── sample_configs/      ← Demo network (4 devices)
└── requirements.txt
```

## Quick Start

### 1. Install dependencies
```bash
cd TopoView
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

- **Upload multiple config files** at once (Cisco IOS, Juniper JunOS)
- **Auto-detects** device type: Router / Firewall / Switch
- **Infers links** by matching shared subnets between interfaces
- **Interactive D3 graph** — drag nodes, zoom, pan
- **Device detail panel** — click any node to see all interfaces, IPs, zones
- **Tooltips** on hover
- **Export to SVG**
- **Demo mode** — click "Load Demo Network" to test with 4 sample devices

## Supported Config Formats

| Vendor | Format | Parsed fields |
|--------|--------|---------------|
| Cisco IOS | `hostname`, `interface`, `ip address`, `description`, `shutdown` | All |
| Cisco ASA | Same + `nameif`, `security-level` | All |
| Juniper JunOS | `host-name`, interface address blocks | Basic |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/parse` | Upload config files, returns topology JSON |
| `POST` | `/api/parse-demo` | Load built-in sample topology |
| `GET`  | `/api/health` | Health check |

## Topology JSON format

```json
{
  "nodes": [
    {
      "id": "R1",
      "hostname": "R1",
      "vendor": "cisco",
      "device_type": "router",
      "interfaces": [
        {
          "name": "GigabitEthernet0/0",
          "ip": "10.0.12.1",
          "subnet": "10.0.12.0/24",
          "description": "Link-to-R2",
          "status": "up"
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
      "subnet": "10.0.12.0/24"
    }
  ]
}
```

## Next Steps (roadmap)

- [ ] Live device polling via SSH (Netmiko)
- [ ] VLAN / routing protocol info overlay
- [ ] Save / load topology sessions
- [ ] Export to draw.io XML