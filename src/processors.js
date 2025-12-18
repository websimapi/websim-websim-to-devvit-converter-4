import * as acorn from 'https://esm.sh/acorn@8.11.3';
import { simple as walkSimple } from 'https://esm.sh/acorn-walk@8.3.2';
import MagicString from 'https://esm.sh/magic-string@0.30.5';

// Processing Logic (Dependencies, Imports, HTML Parsing)

// Helper to sanitize filenames
export const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function uint8ToString(u8) {
  if (typeof u8 === 'string') return u8;
  if (!(u8 instanceof Uint8Array)) return String(u8 ?? '');
  return new TextDecoder().decode(u8);
}

// --- Dependency Management ---

export class DependencyManager {
    constructor() {
        this.downloads = new Map(); // url -> { localPath, processPromise }
        this.packageAliases = new Map(); // canonicalName -> localPath
        this.vendorCount = 0;
    }

    // Resolves an import. 
    // referrerUrl is the absolute URL of the file importing this, or null if it's the root project.
    resolve(importSource, referrerUrl = null) {
        // 1. Determine URL
        let downloadUrl;

        // Helper to normalize CDN URLs to esm.sh for consistency & caching
        const normalizeToEsm = (url) => {
            if (url.includes('unpkg.com/') || url.includes('jsdelivr.net/npm/') || url.includes('cdnjs.cloudflare.com/')) {
                const match = url.match(/(?:unpkg\.com|jsdelivr\.net\/npm|cdnjs\.cloudflare\.com\/ajax\/libs)\/(@?[^@/]+)(?:@([^/]+))?/);
                if (match) {
                    const pkg = match[1];
                    const ver = match[2] ? `@${match[2]}` : '';
                    return `https://esm.sh/${pkg}${ver}?target=es2020&bundle`;
                }
            }
            return url;
        };
        
        if (referrerUrl) {
            // Relative to referrer (inside a vendor file)
            try {
                if (importSource.startsWith('.')) {
                    downloadUrl = new URL(importSource, referrerUrl).href;
                } else if (importSource.startsWith('http')) {
                    downloadUrl = normalizeToEsm(importSource);
                } else if (importSource.startsWith('/')) {
                     const origin = new URL(referrerUrl).origin;
                     downloadUrl = new URL(importSource, origin).href;
                } else {
                    // Bare import in vendor? Assume fresh fetch from esm.sh
                    // Use es2020 to ensure broad compatibility and reduced polyfill bloat
                    downloadUrl = `https://esm.sh/${importSource}?target=es2020&bundle`;
                }
            } catch (e) {
                console.warn("[Converter] Failed to resolve URL", importSource, referrerUrl);
                return importSource;
            }
        } else {
            // Root (User Code) Import
            if (importSource.startsWith('.') || importSource.startsWith('/')) {
                return importSource; // Local project file, ignore
            }
            if (importSource.startsWith('http')) {
                downloadUrl = normalizeToEsm(importSource);
            } else {
                // Bare specifier
                downloadUrl = `https://esm.sh/${importSource}?target=es2020&bundle`;
            }
        }

        // --- SINGLETON ENFORCEMENT ---
        // Detect key libraries to prevent multiple versions loading (Three.js context issues)
        const singletonMap = {
            'three': 'three',
            'three.js': 'three', 
            '@tweenjs/tween.js': 'tween',
            'tween.js': 'tween',
            'pixi.js': 'pixi'
        };

        let detectedPkg = null;
        if (!importSource.startsWith('.') && !importSource.startsWith('/') && !importSource.startsWith('http')) {
             detectedPkg = importSource.split('/')[0];
             if (importSource.startsWith('@')) detectedPkg = importSource.split('/').slice(0,2).join('/');
        } else {
             const u = downloadUrl;
             if (u.includes('/three')) detectedPkg = 'three';
             else if (u.includes('tween.js')) detectedPkg = 'tween.js';
        }

        if (detectedPkg && singletonMap[detectedPkg]) {
            // Only collapse root package imports into the singleton alias.
            // Subpaths (e.g. three/examples/...) should be treated as separate files 
            // (that will internally import the root package).
            
            let isRoot = true;
            if (!importSource.startsWith('http') && !importSource.startsWith('.')) {
                // Bare import: "three" vs "three/examples"
                if (importSource.length > detectedPkg.length && importSource.startsWith(detectedPkg + '/')) {
                    isRoot = false;
                }
            } else if (importSource.includes(detectedPkg)) {
                // URL: esm.sh/three vs esm.sh/three/examples
                const afterPkg = importSource.split(detectedPkg)[1];
                if (afterPkg && afterPkg.startsWith('/') && !afterPkg.startsWith('/@') && !afterPkg.startsWith('?')) {
                     // If it continues with a path that isn't just a version or query
                     // e.g. /three/examples...
                     if (afterPkg.length > 1 && !afterPkg.startsWith('/?')) {
                         isRoot = false;
                     }
                }
            }

            if (isRoot) {
                const canonical = singletonMap[detectedPkg];
                if (this.packageAliases.has(canonical)) {
                    return this.packageAliases.get(canonical);
                }
            }
        }

        // 2. Check Cache
        if (this.downloads.has(downloadUrl)) {
            return this.downloads.get(downloadUrl).localPath;
        }

        // 3. Generate Local Path (Force .js)
        let safeName = `vendor-${this.vendorCount++}`;
        try {
            const u = new URL(downloadUrl);
            const pathParts = u.pathname.split('/');
            const filename = pathParts[pathParts.length - 1];
            if (filename && filename.length < 50) {
                 const base = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9.-]/g, '_');
                 if (base) safeName = `${this.vendorCount}_${base}`;
            }
        } catch(e) {}
        
        const localPath = `./vendor/${safeName}.js`;

        // Register alias if it's a singleton candidate
        if (detectedPkg && singletonMap[detectedPkg]) {
            const canonical = singletonMap[detectedPkg];
            if (!this.packageAliases.has(canonical)) {
                this.packageAliases.set(canonical, localPath);
            }
        }

        console.log(`[Converter] Resolving Dependency: ${importSource} -> ${downloadUrl} -> ${localPath}`);

        // 4. Start Download & Recursion
        const processPromise = (async () => {
            try {
                console.log(`[Converter] Downloading: ${downloadUrl}`);
                const res = await fetch(downloadUrl);
                if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
                let code = await res.text();

                // SPECIAL PATCH: Tween.js interop for common issue where TWEEN.Tween is missing
                if ((safeName.includes('tween') || downloadUrl.includes('tween')) && code.includes('export class Tween') && !code.match(/export\s+default/)) {
                     // Heuristic to export all named exports as default object if default is missing
                     // This fixes cases where 'import TWEEN from "tween.js"' expects a namespace object
                     code += `\n/* Patch for default export */\nvar _def = { Tween: (typeof Tween !== 'undefined' ? Tween : undefined), Easing: (typeof Easing !== 'undefined' ? Easing : undefined), update: (typeof update !== 'undefined' ? update : function(){}) };\nexport default _def;`;
                }

                // Sanitize vendor code to prevent CSP violations (eval, new Function)
                
                // 1. "new Function('return this')()" pattern -> window
                code = code.replace(/new\s+Function\s*\(\s*["']return\s+this["']\s*\)\s*\(\)/g, 'window');
                code = code.replace(/new\s+Function\s*\(\s*["']return\s+this["']\s*\)/g, '(()=>window)');
                
                // 2. "(0, eval)('this')" pattern -> window
                code = code.replace(/\(0,\s*eval\)\s*\(\s*["']this["']\s*\)/g, 'window');
                
                // 3. "eval('this')" pattern -> window
                code = code.replace(/\beval\s*\(\s*["']this["']\s*\)/g, 'window');

                // 4. "Function('return this')()" (without new) -> window
                code = code.replace(/Function\s*\(\s*["']return\s+this["']\s*\)\s*\(\)/g, 'window');
                
                // 5. Replace other common unsafe-eval patterns in webpack/polyfill code
                code = code.replace(/Function\("return this"\)\(\)/g, 'window');

                // 6. Generic Function constructor removal (catch-all for "return this")
                // Be careful not to break valid code, but this specific pattern is strictly for global scope access
                code = code.replace(/Function\s*\(\s*["']return\s+this["']\s*\)\s*\(\)/g, '(()=>window)');

                // Polyfill import.meta.url for environments that might choke on it or if bundling fails
                code = code.replace(/import\.meta\.url/g, 'window.location.href');

                // Use final URL for resolving relative imports (handling redirects)
                const finalUrl = res.url;

                // Recursively rewrite imports in this vendor file
                const rewritePath = (specifier) => {
                     // Resolve the specifier relative to this download
                     const resolvedLocal = this.resolve(specifier, finalUrl);
                     
                     // resolvedLocal is ./vendor/xyz.js
                     // Since this file is also in ./vendor/, imports should be ./xyz.js
                     const parts = resolvedLocal.split('/');
                     return `./${parts[parts.length - 1]}`;
                };

                // Use robust AST processing for vendor files too (they are minified/complex)
                // We use the same processor but with a recursive resolver
                const processed = processJsContentWithAst(code, rewritePath, `Vendor: ${safeName}`);
                
                return `// Source: ${downloadUrl}\n${processed.content}`;
            } catch (err) {
                console.error("[Converter] Vendor download error:", err);
                return `/* Error downloading ${downloadUrl}: ${err.message} */`;
            }
        })();

        this.downloads.set(downloadUrl, { localPath, processPromise });
        return localPath;
    }

    async getVendorFiles() {
        const files = {};
        const processed = new Set();
        
        // Loop until no new downloads appear (handling recursion)
        while(true) {
            const urls = Array.from(this.downloads.keys());
            let hasNew = false;
            
            for(const url of urls) {
                if(processed.has(url)) continue;
                hasNew = true;
                processed.add(url);
                
                const entry = this.downloads.get(url);
                const content = await entry.processPromise;
                
                const zipPath = entry.localPath.replace(/^\.\//, '');
                files[zipPath] = content;
            }
            if(!hasNew) break;
        }
        return files;
    }
}

// AST-based processing for safety against minified code issues
function processJsContentWithAst(js, resolveFn, debugName = 'script') {
    let isModule = false;
    let ast;

    try {
        ast = acorn.parse(js, { sourceType: 'module', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true });
    } catch (e) {
        console.warn(`[Converter] AST Parse failed for ${debugName}. Fallback to original content. Error:`, e.message);
        // Fallback: If it fails to parse, we can't safely rewrite it. 
        // We return original content. Note: If it has imports, they won't be rewritten, 
        // likely leading to runtime errors, but better than corrupting code.
        return { content: js, isModule: false }; 
    }

    const magic = new MagicString(js);

    walkSimple(ast, {
        ImportDeclaration(node) {
            isModule = true;
            if (node.source && node.source.value) {
                const newPath = resolveFn(node.source.value);
                if (newPath !== node.source.value) {
                    magic.overwrite(node.source.start, node.source.end, JSON.stringify(newPath));
                }
            }
        },
        ExportNamedDeclaration(node) {
            isModule = true;
            if (node.source && node.source.value) {
                const newPath = resolveFn(node.source.value);
                if (newPath !== node.source.value) {
                    magic.overwrite(node.source.start, node.source.end, JSON.stringify(newPath));
                }
            }
        },
        ExportAllDeclaration(node) {
            isModule = true;
            if (node.source && node.source.value) {
                const newPath = resolveFn(node.source.value);
                if (newPath !== node.source.value) {
                    magic.overwrite(node.source.start, node.source.end, JSON.stringify(newPath));
                }
            }
        },
        ImportExpression(node) {
            // dynamic import()
            isModule = true; // Technically dynamic import works in scripts too, but implies modular intent
            if (node.source && node.source.type === 'Literal') {
                const newPath = resolveFn(node.source.value);
                if (newPath !== node.source.value) {
                    magic.overwrite(node.source.start, node.source.end, JSON.stringify(newPath));
                }
            }
        },
        MetaProperty(node) {
            if (node.meta.name === 'import' && node.property.name === 'meta') {
                isModule = true;
            }
        }
    });

    return { content: magic.toString(), isModule };
}

// Parse JS files to detect imports, download them, and rewrite paths
export function processJsForImports(jsContent, depManager, filePath = 'root.js') {
  let js = uint8ToString(jsContent);
  
  const resolveFn = (source) => {
      // If it looks like a remote URL or bare import, resolve it
      if (source.startsWith('http') || !source.match(/^\.?\.?\//)) {
          const resolved = depManager.resolve(source);
          
          // Fix path relative to current file depth
          // resolved is usually "./vendor/foo.js" (root relative)
          if (resolved.startsWith('./vendor/')) {
             const depth = filePath.split('/').length - 1;
             if (depth > 0) {
                 const back = '../'.repeat(depth);
                 return back + resolved.slice(2);
             }
          }
          return resolved;
      }
      return source;
  };

  return processJsContentWithAst(js, resolveFn, filePath);
}

// Parse HTML to extract scripts and handle import maps
export function processHtmlForCSP(htmlContent, baseFilename, depManager, knownModules = new Set(), filePath = 'index.html') {
  let html = uint8ToString(htmlContent);
  const extractedScripts = [];
  let scriptCounter = 0;

  // Add DOCTYPE if missing
  if (!html.trim().toLowerCase().startsWith('<!doctype')) {
    html = '<!DOCTYPE html>\n' + html;
  }

  // 1. Inject Logger & Socket Polyfill
  const polyfills = '<script src="logger.js"></script>\n    <script src="websim_socket.js"></script>';
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>\n    ' + polyfills);
  } else if (html.includes('<body>')) {
    html = html.replace('<body>', '<body>\n    ' + polyfills);
  } else {
    html = polyfills + '\n' + html;
  }

  // 2. Handle Import Maps
  // Remove import maps to prevent CSP inline script violations.
  // We rewrite all imports in JS files (including extracted inline scripts) so the map is redundant.
  html = html.replace(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, '<!-- Import Map Removed by Converter -->');

  // 3. Process Scripts
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
    
    // CASE A: External Script
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
        let src = srcMatch[1];
        
        // If it's remote, we must download it!
        if (src.startsWith('http') || src.startsWith('//')) {
            if (src.startsWith('//')) src = 'https:' + src;
            let localPath = depManager.resolve(src);
            
            // Fix path relative to HTML file
            if (localPath.startsWith('./vendor/')) {
                 const depth = filePath.split('/').length - 1;
                 if (depth > 0) {
                     const back = '../'.repeat(depth);
                     localPath = back + localPath.slice(2);
                 }
            }

            return `<script ${attrs.replace(srcMatch[0], `src="${localPath}"`)}>${content}</script>`;
        }

        let filename = src;
        // Clean path to match map keys
        const cleanKey = filename.replace(/^(\.|\/)+/, '');
        
        if (knownModules.has(cleanKey)) {
            if (!attrs.includes('type="module"') && !attrs.includes("type='module'")) {
                return `<script type="module" ${attrs}>${content}</script>`;
            }
        }
        return match;
    }

    // CASE B: Inline Script
    if (!content.trim()) return '';

    // If it's a JSON script (importmap, ld+json), leave it alone
    if (attrs.includes('type="application/json"') || attrs.includes('type="importmap"')) {
        return match;
    }

    scriptCounter++;
    const safeBase = baseFilename.replace(/[^\w-]/g, '_');
    const scriptFilename = `${safeBase}_inline_${scriptCounter}.js`;
    
    let isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    
    const processed = processJsForImports(content, depManager, filePath);
    if (processed.isModule) isModule = true;

    extractedScripts.push({ filename: scriptFilename, content: processed.content });

    let newAttrs = attrs;
    if (isModule && !newAttrs.toLowerCase().includes('type="module"')) {
        newAttrs += ' type="module"';
    }
    
    return `<script src="${scriptFilename}" ${newAttrs}></script>`;
  });

  // Remove CSP violations
  html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');

  return { html, extractedScripts };
}

