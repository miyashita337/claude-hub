// Screenshot Saver - Local server that receives images and saves to disk
// Usage: bun run ~/channel/screenshot-saver/index.ts
// Then navigate Claude in Chrome to http://localhost:3456
// Use upload_image to drop screenshots onto the page

import { mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const SAVE_DIR = resolve(homedir(), "channel", "screenshots");
mkdirSync(SAVE_DIR, { recursive: true });

let lastSavedPath = "";

Bun.serve({
  port: 3456,
  routes: {
    "/": new Response(
      `<!DOCTYPE html>
<html>
<head><title>Screenshot Saver</title></head>
<body style="background:#1a1a2e;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0">
  <h1>Screenshot Saver</h1>
  <p>Drop or paste a screenshot here</p>
  <div id="drop" style="width:600px;height:300px;border:3px dashed #5865F2;border-radius:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;margin:20px">
    <input type="file" id="file" accept="image/*" style="position:absolute;width:600px;height:300px;opacity:0;cursor:pointer">
    <span id="label">Click or drag image here</span>
  </div>
  <div id="result" style="color:#4ade80;margin-top:10px"></div>
  <div id="history" style="margin-top:20px;max-width:800px"></div>
  <script>
    const fileInput = document.getElementById('file');
    const label = document.getElementById('label');
    const result = document.getElementById('result');

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      label.textContent = 'Uploading...';
      const formData = new FormData();
      formData.append('image', file);
      const name = prompt('Filename (without extension):', 'screenshot-' + Date.now()) || 'screenshot-' + Date.now();
      formData.append('name', name);
      const res = await fetch('/upload', { method: 'POST', body: formData });
      const data = await res.json();
      result.textContent = 'Saved: ' + data.path;
      label.textContent = 'Click or drag another image';
      fileInput.value = '';
    });

    // Also handle paste
    document.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          label.textContent = 'Uploading pasted image...';
          const formData = new FormData();
          formData.append('image', file);
          const name = 'screenshot-' + Date.now();
          formData.append('name', name);
          const res = await fetch('/upload', { method: 'POST', body: formData });
          const data = await res.json();
          result.textContent = 'Saved: ' + data.path;
          label.textContent = 'Click or drag another image';
        }
      }
    });
  </script>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } }
    ),
  },
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/upload" && req.method === "POST") {
      const formData = await req.formData();
      const image = formData.get("image") as File;
      const name = (formData.get("name") as string) || `screenshot-${Date.now()}`;

      if (!image) {
        return Response.json({ error: "No image provided" }, { status: 400 });
      }

      const ext = image.type === "image/png" ? "png" : image.type === "image/jpeg" ? "jpg" : "png";
      const filename = `${name}.${ext}`;
      const filepath = resolve(SAVE_DIR, filename);

      await Bun.write(filepath, image);
      lastSavedPath = filepath;

      console.log(`[Screenshot Saver] Saved: ${filepath} (${(image.size / 1024).toFixed(1)}KB)`);
      return Response.json({ path: filepath, size: image.size });
    }

    if (url.pathname === "/last") {
      return Response.json({ path: lastSavedPath });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`[Screenshot Saver] Running at http://localhost:3456`);
console.log(`[Screenshot Saver] Save directory: ${SAVE_DIR}`);
