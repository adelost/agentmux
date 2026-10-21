import { component, feature, expect } from 'bdd-vitest';
import { vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

feature('State mutation reads under its lock',()=>{
  component('a writer between initial content and file stamp is retained by the next mutation',{
    given:['a real file and a second atomic writer at the read boundary',()=>{
      const root=mkdtempSync(join(tmpdir(),'amux-state-initial-')),path=join(root,'state.json');
      writeFileSync(path,JSON.stringify({original:1}));return{root,path};
    }],
    when:['constructing a stale reader and then writing through its public API',async f=>{
      let swap=true;
      vi.doMock('fs',async()=>{const fs=await vi.importActual('fs');return{...fs,readFileSync(...args){
        const bytes=fs.readFileSync(...args);
        if(args[0]===f.path&&swap){swap=false;fs.writeFileSync(f.path+'.other',JSON.stringify({original:1,concurrent:2}));fs.renameSync(f.path+'.other',f.path);}
        return bytes;
      }};});
      try{const{createState}=await import('./state.mjs?initial-stamp-race');const state=createState(f.path);state.set('own',3);return JSON.parse(readFileSync(f.path,'utf8'));}
      finally{vi.doUnmock('fs');rmSync(f.root,{recursive:true,force:true});}
    }],
    then:['both writers values remain',value=>expect(value).toEqual({original:1,concurrent:2,own:3})],
  });
});
