// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// server.js — VORTREXYN Express Backend
// Responsibilities:
//   1. Serve the entire project as static files (HTML, CSS, JS, assets)
//   2. Expose a single POST endpoint: /api/generate-car-image
//      which calls the OpenAI DALL-E 3 API and returns a compressed
//      base64 JPEG data URL that gets stored in Firestore with the car doc.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Express — lightweight Node.js web framework for routing and middleware
const express = require('express');

// path — built-in Node module for resolving file system paths correctly
// on any OS (handles Windows vs Unix slash differences)
const path    = require('path');

// sharp — high-performance image processing library (resize + compress)
// Used here to shrink DALL-E's 1024×1024 PNG down to a 900×600 JPEG
// so it fits within Firestore's 1 MB document size limit
const sharp   = require('sharp');

// ── Create the Express app instance ──────────────────────────────────────────
const app = express();

// Parse incoming JSON request bodies up to 10 MB.
// The 10 MB limit allows for large base64 payloads if ever needed.
app.use(express.json({ limit: '10mb' }));

// Serve every file in the project root as a static asset.
// { extensions: ['html'] } means a request to /public/admin will
// automatically resolve to /public/admin.html (no manual redirects needed).
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ── POST /api/generate-car-image ─────────────────────────────────────────────
// Admin calls this from the Add Car modal after filling in brand/model/etc.
// Returns: { imageUrl: "data:image/jpeg;base64,..." }
// The returned data URL is stored directly in the car's Firestore document.
app.post('/api/generate-car-image', async (req, res) => {

  // Destructure the car details sent from the admin form
  const { brand, model, type, year, fuel } = req.body;

  // Guard: brand and model are mandatory for a meaningful image prompt
  if (!brand || !model) {
    return res.status(400).json({ error: 'Brand and model are required.' });
  }

  // Build a descriptive DALL-E 3 prompt using the car's attributes.
  // The prompt is written as professional photography brief to bias the AI
  // toward clean, catalog-style automotive images with no text or watermarks.
  const prompt =
    `Professional automotive photography of a ${year || ''} ${brand} ${model}, ` +
    `${type || 'car'}, ${fuel || ''} engine. ` +
    `Luxury car rental studio shot, three-quarter front angle, dramatic dark background ` +
    `with subtle gradient, high-end automotive magazine style, ultra-realistic, 8k quality, ` +
    `no text, no watermarks.`;

  try {
    // Call the OpenAI Images API (DALL-E 3 model).
    // We request the image in b64_json format so we never need to
    // download from a temporary URL — the binary data arrives inline.
    const openaiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The API key is stored as an environment variable so it is never
        // visible in source code or version control
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'dall-e-3',      // Use DALL-E 3 (highest quality OpenAI image model)
        prompt,                  // The descriptive car photography prompt built above
        n: 1,                    // Generate exactly one image per request
        size: '1024x1024',       // Largest supported standard size for DALL-E 3
        response_format: 'b64_json' // Return raw base64 bytes, not a hosted URL
      })
    });

    // Parse the JSON response from OpenAI
    const data = await openaiRes.json();

    // If OpenAI returned an HTTP error (e.g. rate limit, bad prompt, billing issue),
    // forward the error message back to the admin UI
    if (!openaiRes.ok) {
      return res.status(500).json({ error: data.error?.message || 'OpenAI error' });
    }

    // data.data[0].b64_json is the raw image as a base64 string.
    // Convert it to a Node Buffer so sharp can process it.
    const rawBuffer = Buffer.from(data.data[0].b64_json, 'base64');

    // ── Compress the image ──────────────────────────────────────────────────
    // DALL-E returns a 1024×1024 PNG (~1–3 MB). That is too large to store
    // in a Firestore document (1 MB limit). We:
    //   • resize to 900×600 (landscape crop, suitable for car cards)
    //   • convert to JPEG at quality 82 (visually lossless, ~80–150 KB)
    const compressed = await sharp(rawBuffer)
      .resize(900, 600, {
        fit: 'cover',       // Fill 900×600 exactly, cropping if needed
        position: 'center'  // Keep the centre of the image (the car body)
      })
      .jpeg({ quality: 82 }) // Encode as JPEG — ~60-70% size saving vs PNG
      .toBuffer();           // Return the compressed image as a Node Buffer

    // Encode the compressed JPEG as a base64 data URL.
    // This is the string stored in Firestore and used directly as <img src="...">
    const dataUrl = 'data:image/jpeg;base64,' + compressed.toString('base64');

    // Send the data URL back to the admin frontend
    res.json({ imageUrl: dataUrl });

  } catch (e) {
    // Catch any unexpected errors (network failures, sharp errors, etc.)
    // and return a 500 with the error message so the admin UI can display it
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ── POST /api/generate-car-description ───────────────────────────────────────
// Admin calls this from the Add Car modal to auto-fill the description textarea.
// Uses OpenAI GPT-4o-mini (Chat Completions) to produce a short, polished
// marketing description based on the car's attributes.
// Returns: { description: "..." }
app.post('/api/generate-car-description', async (req, res) => {

  // Destructure the car details sent from the admin form
  const { brand, model, type, year, fuel, mileage, price } = req.body;

  // Guard: need at least brand + model for a meaningful description
  if (!brand || !model) {
    return res.status(400).json({ error: 'Brand and model are required.' });
  }

  // Build the prompt — ask GPT for a concise premium-rental-style blurb
  const userPrompt =
    `Write a short, premium car rental description (3–4 sentences) for a ` +
    `${year || ''} ${brand} ${model} ${type || ''} with ${fuel || ''} engine` +
    `${mileage ? ', ' + mileage + ' on the odometer' : ''}` +
    `${price ? ', priced at AUD $' + price + ' per day' : ''}. ` +
    `Tone: luxury, confident, enticing. No bullet points. Plain text only.`;

  try {
    // Call the OpenAI Chat Completions API
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',  // Fast + cheap model — perfect for short text generation
        messages: [
          {
            role: 'system',
            content: 'You are a luxury car rental copywriter. Write vivid, concise vehicle descriptions.'
          },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 150,  // Keep the description short (3–4 sentences)
        temperature: 0.8  // Slight creativity without going off-brand
      })
    });

    const data = await openaiRes.json();

    // Forward any OpenAI error back to the frontend
    if (!openaiRes.ok) {
      return res.status(500).json({ error: data.error?.message || 'OpenAI error' });
    }

    // Extract the generated text and strip leading/trailing whitespace
    const description = data.choices[0].message.content.trim();

    res.json({ description });

  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// ── Start the HTTP server ─────────────────────────────────────────────────────
// process.env.PORT is set by the hosting environment (defaults to 5000 locally).
// Binding to '0.0.0.0' makes the server reachable from all network interfaces,
// not just localhost — required when running behind a reverse proxy or in the cloud.
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`VORTREXYN server running on port ${PORT}`);
});
