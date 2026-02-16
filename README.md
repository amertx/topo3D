# TopoScope — 3D Regional Terrain Explorer

Interactive 3D topographic terrain explorer built with React and Three.js. Search any location to generate elevation models with contour lines, landmark pins, 3D city skylines, and elevation data — all displayed in feet.

## Deploy to Netlify

### Option 1: One-click (easiest)

1. Push this folder to a GitHub repo
2. Go to [app.netlify.com](https://app.netlify.com)
3. Click **"Add new site" → "Import an existing project"**
4. Connect your GitHub repo
5. Build settings will auto-detect from `netlify.toml`:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
6. **Add your environment variable** before deploying:
   - Go to **Site settings → Environment variables**
   - Add: `ANTHROPIC_API_KEY` = your Anthropic API key
7. Deploy!

### Option 2: Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# From this directory:
npm install
netlify login
netlify init        # or netlify link if site already exists

# Set your API key
netlify env:set ANTHROPIC_API_KEY sk-ant-your-key-here

# Deploy
netlify deploy --build --prod
```

### Option 3: Drag & drop

```bash
npm install
npm run build
```
Then drag the `dist/` folder to [app.netlify.com/drop](https://app.netlify.com/drop).
Note: you'll still need to add the Netlify function manually and set the env variable.

## Important: API Key

This app requires an Anthropic API key to generate terrain data. The key is stored securely as a Netlify environment variable and proxied through a serverless function — it's never exposed to the browser.

**Set it in Netlify:**  
Site settings → Environment variables → `ANTHROPIC_API_KEY`

## Local Development

```bash
npm install
npm run dev
```

Note: Local dev won't work without the Netlify function. Use `netlify dev` instead to run both the Vite dev server and Netlify Functions locally:

```bash
netlify dev
```

## Tech Stack

- **React 18** + **Three.js** for 3D rendering
- **Vite** for build tooling
- **Netlify Functions** for secure API proxying
- **Claude API** (Sonnet) for terrain data generation
