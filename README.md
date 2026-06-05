# Chrome DevTools MCP

A lightweight MCP (Model Context Protocol) server that exposes Chrome DevTools capabilities over HTTP.

## Prerequisites

- Node.js (Latest LTS version recommended)
- npm

## Installation

Clone the repository:

```bash
git clone https://github.com/bipulsardar091-glitch/chrome-devtools-mcp.git
```

Navigate to the project directory:

```bash
cd chrome-devtools-mcp
```

## Running the Server

Start the application:

```bash
npm run start
```

The start command will:

1. Install all required dependencies.
2. Initialize the application.
3. Start the MCP server.

## Server Endpoints

### Base URL

```text
http://localhost:3000
```

### MCP Endpoint

```text
http://localhost:3000/mcp
```

## Usage

Once the server is running, MCP-compatible clients can connect to:

```text
http://localhost:3000/mcp
```

and interact with Chrome DevTools through the exposed MCP interface.

## Development

To run the project locally:

```bash
git clone https://github.com/bipulsardar091-glitch/chrome-devtools-mcp.git
cd chrome-devtools-mcp
npm run start
```

The server will be available at:

```text
http://localhost:3000
```

with the MCP endpoint exposed at:

```text
http://localhost:3000/mcp
```

## License

MIT License