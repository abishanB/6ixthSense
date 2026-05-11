# 6ixth Sense

6ixth Sense is a spatial planning tool for analyzing how proposed construction projects may affect traffic, nearby roads, and regulatory requirements in Toronto.

Users can place planned buildings on a 3D map, run a traffic simulation, detect impacted road segments, and generate an AI-powered construction impact report using real network metrics and construction regulation documents.

## 🎯 Project Scope

The project focuses on three main areas:

1. Interactive urban mapping
2. Traffic and road impact analysis
3. AI-generated construction impact reporting

The app allows users to:

- Explore a 3D map of Downtown Toronto
- Place a building or draw a custom building footprint
- Adjust building height and footprint
- Detect roads that intersect with or are near the building
- View road metrics such as road type, distance, traffic volume, volume to capacity ratio, and delay
- Toggle road closures and recompute traffic flow
- Generate a construction impact report based on traffic data, construction inputs, and Toronto regulations

## 🗺️ Map Interface

The frontend is built with React, TypeScript, and MapLibre GL. Users interact with a 3D map of Downtown Toronto to explore roads, buildings, and traffic conditions.

Users can select or deselect road segments directly on the map to mark closures or affected roads. The selected roads are highlighted visually and used as inputs for the traffic simulation.

Users can also add proposed buildings by placing a point or drawing a custom footprint on the map. Buildings are rendered with 3D extrusions, and their footprints are used to detect nearby or intersecting roads.

## 🚦 Traffic Simulation

The traffic simulation uses a GeoJSON road network modeled as a graph, with intersections as nodes and roads as weighted edges.

Synthetic origin destination demand is routed through the network using Dijkstra’s algorithm. Traffic volume is assigned to road segments, then BPR-style congestion functions estimate delay, congestion, and volume to capacity ratio.

When roads are closed or affected by a building footprint, the graph is updated and traffic is recomputed to compare baseline and post-closure conditions.

## 🤖 AI and RAG

The AI impact report uses Retrieval Augmented Generation through Backboard.io. Toronto bylaw and regulation documents are processed so that relevant rules and guidelines can be retrieved before generating a report.

The app sends construction details, impacted roads, and traffic metrics to Gemini 2.5 Pro, which generates traffic, environmental, economic, and regulatory analysis grounded in Toronto-specific documents.

## 🛠️ Tech Stack

### 💻 Frontend

- React
- TypeScript
- Mapbox & MapLibre GL

### ⚙️ Backend

- Express
- Node.js

### 🧠 AI and RAG

- Backboard.io
- Gemini 2.5 Pro

### 🗄️ Optional Storage

- Supabase for projects, buildings, and report history

## 🚀 Future Improvements

- Integrate live traffic data instead of synthetic traffic assignment
- Export generated reports as PDFs
- Add support for other cities by swapping the regulatory document set
- Improve simulation performance for larger road networks
- Add project history and saved scenarios
