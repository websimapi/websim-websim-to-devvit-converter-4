import JSZip from 'jszip';
import { 
    cleanName, 
    DependencyManager, 
    processJsForImports, 
    processHtmlForCSP 
} from './processors.js';

import {
    generatePackageJson,
    generateDevvitYaml,
    tsConfig,
    getMainTsx,
    simpleLoggerJs,
    websimSocketPolyfill,
    validateScript,
    setupScript,
    generateReadme
} from './templates.js';

// removed helper functions: cleanName, uint8ToString (moved to processors.js)

// removed DependencyManager class (moved to processors.js)
// removed processJsForImports function (moved to processors.js)
// removed processHtmlForCSP function (moved to processors.js)

// removed template generators: generatePackageJson, generateDevvitYaml, tsConfig, getMainTsx... (moved to templates.js)

export async function generateDevvitZip(projectMeta, assets, includeReadme = true) {
    const zip = new JSZip();
    
    const safeId = projectMeta.project.id ? projectMeta.project.id.slice(0, 6) : '000000';
    const rawSlug = projectMeta.project.slug || "websim-game";
    const projectSlug = cleanName(`${rawSlug}-${safeId}`);
    const projectTitle = projectMeta.project.title || "WebSim Game";

    // 1. Config Files
    zip.file("package.json", generatePackageJson(projectSlug));
    zip.file("devvit.yaml", generateDevvitYaml(projectSlug));
    zip.file("tsconfig.json", tsConfig);
    zip.file(".gitignore", "node_modules\n.devvit");
    
    if (includeReadme) {
        zip.file("README.md", generateReadme(projectTitle, `https://websim.ai/p/${projectMeta.project.id}`));
    }

    zip.file("scripts/setup.js", setupScript);
    zip.file("scripts/validate.js", validateScript);

    // 2. Web Root Processing
    const webRoot = zip.folder("webroot");
    
    // Identify Index
    let indexPath = 'index.html'; 
    let foundIndex = false;
    let indexDir = '';

    for (const p of Object.keys(assets)) {
        if (p.endsWith('index.html')) {
            indexPath = p;
            foundIndex = true;
            // Determine directory of index.html for debug-bridge placement
            const parts = p.split('/');
            parts.pop();
            indexDir = parts.length > 0 ? parts.join('/') + '/' : '';
            break; // Use the first index found
        }
    }
    
    if (!foundIndex) {
        webRoot.file("index.html", "<html><body><h1>Game Found No Index</h1></body></html>");
    }

    // --- Execution ---
    const depManager = new DependencyManager();
    const processedFiles = {};
    const knownModules = new Set();
    
    // Pass 1: JS Files - Identify Modules & Rewrite Imports
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        if (path.endsWith('.js') || path.endsWith('.mjs')) {
            const { content: processed, isModule } = processJsForImports(content, depManager, path);
            processedFiles[path] = processed;
            if (isModule) knownModules.add(path);
        } else if (!path.endsWith('.html')) {
            // Static assets
            processedFiles[path] = content;
        }
    }

    // Pass 2: HTML Files - Inject Debugger, Fix Paths, Handle Scripts, Resolve Import Maps
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        if (path.endsWith('.html')) {
            const { html, extractedScripts } = processHtmlForCSP(content, path.split('/').pop(), depManager, knownModules, path);
            processedFiles[path] = html;
            
            // Handle extracted inline scripts
            extractedScripts.forEach(s => {
                const parts = path.split('/');
                parts.pop();
                const dir = parts.join('/');
                const fullPath = dir ? `${dir}/${s.filename}` : s.filename;
                processedFiles[fullPath] = s.content;
            });
        }
    }

    // Pass 3: Resolve & Download External Dependencies
    // This is async and might take a moment
    const vendorFiles = await depManager.getVendorFiles();
    for (const [vPath, vContent] of Object.entries(vendorFiles)) {
        webRoot.file(vPath, vContent);
    }

    // Write all processed files to zip
    for (const [path, content] of Object.entries(processedFiles)) {
        webRoot.file(path, content);
    }

    // Add Logger & Socket Polyfill
    webRoot.file("logger.js", simpleLoggerJs);
    webRoot.file("websim_socket.js", websimSocketPolyfill);
    
    const htmlDirs = new Set();
    // Re-scan for html dirs
    for (const [path, content] of Object.entries(processedFiles)) {
        if (path.endsWith('.html')) {
             const parts = path.split('/');
             parts.pop();
             if (parts.length > 0) {
                 htmlDirs.add(parts.join('/') + '/');
             }
        }
    }
    
    htmlDirs.forEach(dir => {
        webRoot.file(`${dir}logger.js`, simpleLoggerJs);
        webRoot.file(`${dir}websim_socket.js`, websimSocketPolyfill);
    });

    // 3. Source Code (Main.tsx)
    zip.file("src/main.tsx", getMainTsx(projectTitle, indexPath));

    const blob = await zip.generateAsync({ type: "blob" });
    return { blob, filename: `${projectSlug}-devvit.zip` };
}

