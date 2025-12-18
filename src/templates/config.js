export const generatePackageJson = (slug) => JSON.stringify({
  "name": slug,
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "devvit playtest",
    "setup": "node scripts/setup.js", 
    "register": "devvit upload",
    "upload": "devvit upload",
    "validate": "node scripts/validate.js"
  },
  "dependencies": {
    "@devvit/public-api": "latest",
    "@devvit/kit": "latest",
    "@devvit/web": "latest"
  },
  "devDependencies": {
    "devvit": "latest",
    "typescript": "^5.0.0"
  }
}, null, 2);

export const generateDevvitYaml = (slug) => `
name: ${slug}
version: 0.1.0
webroot: webroot
`;

export const tsConfig = JSON.stringify({
  "compilerOptions": {
    "target": "es2020",
    "module": "es2020",
    "moduleResolution": "node",
    "lib": ["es2020", "dom"],
    "jsx": "react",
    "jsxFactory": "Devvit.createElement",
    "jsxFragmentFactory": "Devvit.Fragment",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noImplicitAny": false
  },
  "include": [
    "src"
  ]
}, null, 2);

