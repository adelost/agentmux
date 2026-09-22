import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const studioRoot=path.resolve(process.env.STUDIO_ROOT??path.join(root,'../circlekit/product-studio'));
const amuxRoot=path.resolve(process.env.AMUX_ROOT??root);
try {
  const {launch}=await import(pathToFileURL(path.join(studioRoot,'lib/launch.mjs')).href);
  process.exitCode=await launch({root,amuxRoot});
} catch(error) {
  console.error(`${error.message}\nUse the matching Studio branch. Install its locked dependencies once with: cd "${studioRoot}" && npm ci\nAMUX grammar owner: "${amuxRoot}". Override STUDIO_ROOT / AMUX_ROOT for other locations.`);
  process.exitCode=1;
}
