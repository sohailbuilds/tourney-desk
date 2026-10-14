# Tourney Desk

A tournament registration and management platform for gaming communities. Organizers can publish tournaments, collect registrations, track payment status, manage room details, scan match-result screenshots, and publish leaderboards.

## Requirements

- Node.js 22.5 or later (Node.js 24 is recommended).
- A persistent writable directory for the SQLite database and uploaded files.

## Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and configure the required values.
3. Start the application: `npm start`
4. Open `http://localhost:3000/admin` to access the administrator login. Local development has fallback credentials only when `NODE_ENV` is not `production`; never use those defaults in a deployed environment.

## Environment variables

- `NODE_ENV`: Set to `production` when deployed.
- `PORT`: Port provided by the hosting platform.
- `BASE_URL`: Canonical HTTPS URL of the deployed website.
- `ADMIN_PASSWORD`: Unique administrator password, at least 14 characters.
- `SECRET`: Random signing secret, at least 32 characters.
- `DATA_DIR`: Persistent directory for `app.db` and uploaded payment/result images.
- `GEMINI_API_KEY`: Optional API key for reading match results from screenshots. Manual result entry remains available without it.
- `PLATFORM_UPI`: UPI ID used by organizers to pay for platform credits.
- `BRAND`: Optional brand name displayed in the interface.
- `SIGNUP_CREDITS`: Optional number of credits granted to new organizers.
- `SCAN_LIMIT`: Optional screenshot scan limit per tournament.

Do not commit `.env` or upload it to your hosting provider. Configure environment variables in the provider dashboard.

## Deployment checklist

1. Push the project to a private GitHub repository.
2. Deploy it as a Node.js web service on a host that supports persistent storage.
3. Mount a persistent volume at `/data` and set `DATA_DIR=/data`.
4. Configure all required production environment variables, including a strong `ADMIN_PASSWORD`, a random `SECRET`, and the canonical HTTPS `BASE_URL`.
5. Deploy and verify organizer signup/login, tournament creation, registration, uploads, payment-status management, result scanning/manual entry, and leaderboard access.
6. Connect the custom domain in the hosting dashboard and apply the exact DNS records supplied by the host. Confirm HTTPS works before testing authentication cookies.
7. Configure automated backups for the SQLite database and uploads, and test restoring a backup.

See [SECURITY.md](SECURITY.md) for security notes and remaining limitations.

## Routes and workflow

- `/admin`: Platform administration, organizer management, credit-request approval, and tournament oversight.
- `/panel`: Organizer dashboard, tournament management, registrations, match results, and credit requests.
- `/:organizer/:tournament`: Public tournament registration page.
- `/r/:token`: Private registration status and room-details page. Keep this link private.

Organizers create drafts for free. Publishing a tournament consumes one credit. Players pay entry fees directly to the organizer's UPI ID; the platform does not process those payments. Platform credit purchases require administrator approval.

## Project files

- `server.js`: Express application, routes, database schema, authentication, and upload handling.
- `views/`: EJS templates for public pages and dashboards.
- `public/style.css`: Application styling.
- `gemini.js`: AI-assisted result screenshot reading.
- `scoring.js`: Leaderboard scoring and sorting.
- `templates.js`: Default registration form templates.
- `plans.js`: Credit plans and pricing.
