import {rm,mkdir,copyFile,cp} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist');
await copyFile('index.html','dist/index.html');
await cp('src','dist/src',{recursive:true});await cp('shared','dist/shared',{recursive:true});
console.log('Static frontend built in dist; server source and docs are excluded.');
