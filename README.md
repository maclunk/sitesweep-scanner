# SiteSweep Scanner Service

Standalone Express microservice for Playwright-based website scanning.

## Features

- Performs automated website scans using Playwright
- Checks for SSL, viewport meta tags, legal pages (Impressum, Datenschutz)
- Returns structured scan results with scores and issues
- Docker-ready for Railway deployment

## Setup

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Install Playwright browsers:
```bash
npx playwright install chromium
```

3. Start development server:
```bash
npm run dev
```

4. Start production server:
```bash
npm start
```

## Environment Variables

- `PORT` - Server port (default: 8080)
- `FRONTEND_URL` - Allowed CORS origin (default: *)

## API Endpoints

### POST /scan

Scans a website and returns results.

**Request:**
```json
{
  "url": "https://example.com",
  "jobId": "optional-job-id"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "score": 85,
    "summary": "Analysis completed...",
    "issues": [...],
    "scoreBreakdown": {
      "technical": 80,
      "seo": 90,
      "legal": 85,
      "ux": 85
    },
    "scoreRaw": 85,
    "mobileScreenshotUrl": null
  }
}
```

### GET /health

Health check endpoint.

## Docker Deployment

Build and run:
```bash
docker build -t sitesweep-scanner .
docker run -p 8080:8080 sitesweep-scanner
```

## Railway Deployment

The Dockerfile is configured for Railway. Set the `PORT` environment variable in Railway dashboard.

