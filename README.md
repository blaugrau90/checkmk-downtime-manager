# Checkmk Downtime Manager

A clean, self-hosted web UI for setting host and service downtimes in Checkmk — built with Node.js/Express and deployable as a single Docker container.

![Docker Image Version](https://img.shields.io/docker/v/blaugrau90/checkmk-downtime-manager?sort=semver&label=version)
![Docker Pulls](https://img.shields.io/docker/pulls/blaugrau90/checkmk-downtime-manager)
![License](https://img.shields.io/github/license/blaugrau90/checkmk-downtime-manager)

## Features

- **Site selection** — supports Checkmk distributed monitoring with multiple sites
- **Host search** — searchable, scrollable host list loaded per site
- **Scope selection** — set downtime for the whole host or specific services
- **Service selection** — multi-select checkbox list per host
- **Flexible time input** — quick buttons (30min / 1h / 2h / 4h / 8h) + manual datetime range
- **Secure** — Checkmk credentials stay server-side, never exposed to the browser
- **Self-signed certificates** — optional SSL verification bypass for internal setups

## Screenshots

> Dark UI in Checkmk green, designed for monitoring environments.
<img width="665" height="336" alt="image" src="https://github.com/user-attachments/assets/3cb4c2f2-e38a-4a57-897a-48b6bb2823af" />


## Quick Start

```bash
# Pull from Docker Hub
docker pull blaugrau90/checkmk-downtime-manager:latest

# Create your .env file
cp .env.example .env
# → edit .env with your Checkmk credentials

# Run
docker run -d \
  --name checkmk-downtime-manager \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  blaugrau90/checkmk-downtime-manager:latest
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `CHECKMK_URL` | ✓ | Checkmk server URL, no trailing slash (e.g. `https://monitoring.example.com`) |
| `CHECKMK_SITE` | ✓ | Central site name (e.g. `central`) |
| `CHECKMK_USERNAME` | ✓ | Checkmk automation user |
| `CHECKMK_PASSWORD` | ✓ | Automation user secret |
| `PORT` | – | Web server port (default: `3000`) |
| `CHECKMK_IGNORE_SSL` | – | Set `true` to ignore self-signed certificates |

### Checkmk Automation User

Create a dedicated automation user in Checkmk:
**Setup → Users → Add user** → set *Authentication type* to **Automation secret**

Required permissions: `Monitor`, `Downtime management`

## Docker Compose

```yaml
services:
  checkmk-downtime-manager:
    image: blaugrau90/checkmk-downtime-manager:latest
    ports:
      - "3000:3000"
    env_file: .env
    restart: unless-stopped
```

## Development

```bash
git clone https://github.com/blaugrau90/checkmk-downtime-manager.git
cd checkmk-downtime-manager
cp .env.example .env  # fill in your values

make dev       # build and run locally
make build     # build Docker image
make push      # push to Docker Hub
make release   # build + push
make stop      # stop container
make clean     # remove local image
```

## API Endpoints

The Express backend exposes these endpoints (all proxied to Checkmk):

| Endpoint | Description |
|----------|-------------|
| `GET /api/sites` | List all monitoring sites |
| `GET /api/hosts?site=X` | List hosts for a site |
| `GET /api/services?host=X` | List services for a host |
| `POST /api/downtime` | Set host or service downtime |
| `GET /api/build` | Returns current version |

## License

MIT © [blaugrau90](https://github.com/blaugrau90)
