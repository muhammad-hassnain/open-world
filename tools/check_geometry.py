#!/usr/bin/env python3
"""Check packed scenery, lighting equivalence and adaptive resolution using real Three.js.
Run with the local server: python3 tools/check_geometry.py --channel chrome
"""
import argparse
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

CHECK = r"""async () => {
  const T = await import('three');
  const {GeoBuilder} = await import('/js/util.js'), {indexGeometry} = await import('/js/geometry.js');
  const {GroundSurface} = await import('/js/surface.js');
  const {optimizeLighting, RenderQuality} = await import('/js/rendering.js');
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const b = new GeoBuilder({uv:true}), color = new T.Color(.004, .15, .72);
  for (let i=0;i<120;i++) {
    b.uvWall(1,0).box(i*3,1,0,1,0,1,1,1,color);
    b.uvPlanar().polygon([[i*3,4],[i*3+2,4],[i*3+2,6],[i*3,6]],[],.1,color);
  }
  const g = b.build(), original = Object.fromEntries(Object.entries(g.attributes).map(([k,a])=>[k,a.array.slice()]));
  const bytes = g=>Object.values(g.attributes).reduce((s,a)=>s+a.array.byteLength,0)+(g.index?.array.byteLength||0);
  const before = bytes(g), surfaceBefore=await GroundSurface.build([{name:'road',geometry:g,userData:{}}]);
  assert(g.attributes.normal.array instanceof Int16Array, 'normal buffer not compact');
  assert(g.attributes.color.array instanceof Uint16Array, 'color buffer not compact');
  for(let i=0;i<b.n.length;i++) assert(Math.abs(b.n[i]-g.attributes.normal.array[i]/32767)<.000016,'normal precision');
  for(let i=0;i<b.c.length;i++) assert(Math.abs(b.c[i]-g.attributes.color.array[i]/65535)<.000008,'color precision');
  let ticks=0;await indexGeometry(g,{tick:async()=>ticks++});
  assert(g.index&&bytes(g)<before&&ticks>0,'index did not save memory or yield');
  const expanded=g.toNonIndexed();
  for(const [name,array] of Object.entries(original)) for(let i=0;i<array.length;i++)
    assert(array[i]===expanded.attributes[name].array[i],`changed vertex ${name}/${i}`);
  const surfaceAfter=await GroundSurface.build([{name:'road',geometry:g,userData:{}}]);
  for(let x=0;x<360;x+=.7)for(let z=4;z<6;z+=.4)
    assert(surfaceBefore.heightAt(x,z)===surfaceAfter.heightAt(x,z),'ground contacts changed');
  const hdr=new GeoBuilder();hdr.tri(0,0,0,1,0,0,0,0,1,new T.Color(1.2,.1,.1));
  assert(hdr.build().attributes.color.array instanceof Float32Array,'HDR colors clamped');
  // Boundary regressions: duplicate UV positions with distinct normals/colors were
  // checked above; a large mesh must use 32-bit indices without truncating vertices.
  const large=new T.BufferGeometry(), pos=new Float32Array(70000*6);
  for(let i=0;i<70000;i++)for(let copy=0;copy<2;copy++)pos.set([i,i%7,i%13],(i*2+copy)*3);
  large.setAttribute('position',new T.BufferAttribute(pos,3));await indexGeometry(large);
  assert(large.index.array instanceof Uint32Array&&large.attributes.position.count===70000,'32-bit index boundary');
  // Return visits must reload pruned elevation even when the map data is cached.
  const {Terrain}=await import('/js/terrain.js'), {Frame}=await import('/js/geo.js');
  const {ChunkManager}=await import('/js/chunks.js');
  const frame=new Frame(38.54428,-121.7438), terrain=new Terrain(frame), tile=frame.tileAt(0,0,14);
  const manager=Object.create(ChunkManager.prototype);manager.terrain=terrain;
  manager.tiles=new Map([[`14/${tile.x}/${tile.y}`,Promise.resolve({roads:[]})]]);
  const originalFetch=window.fetch, png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAADG0lEQVR4nO3OQQ0AMAgAMcROCNIn4x40qYDOvoGz+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGE+gGEPuOsDV3OcJ4HAAAAAElFTkSuQmCC'),c=>c.charCodeAt(0));
  let downloads=0;
  window.fetch=(url,...args)=>String(url).includes('elevation-tiles-prod')
    ? (downloads++,Promise.resolve(new Response(png))) : originalFetch(url,...args);
  try {
    await manager._tile(tile.x,tile.y);assert(terrain.at(0,0)===100,'initial elevation');
    terrain.prune(100000,100000,1000);assert(terrain.tiles.size===0,'terrain tiles not pruned');
    await manager._tile(tile.x,tile.y);
    assert(terrain.at(0,0)===100&&downloads===8,'cached return visit flattened terrain');
    assert(terrain.pending.size===0,'completed terrain requests retained');
  } finally { window.fetch=originalFetch; }
  // Compare rendered pixels to the original r160 lighting, including disabled lamps,
  // finite/infinite range, the cutoff edge and spot cone. No approximation is allowed.
  const originalLighting=T.ShaderChunk.lights_fragment_begin;
  const render=()=>{
    const r=new T.WebGLRenderer(), target=new T.WebGLRenderTarget(48,48), scene=new T.Scene();
    const camera=new T.PerspectiveCamera(50,1,.1,100);camera.position.set(0,0,6);
    const mesh=new T.Mesh(new T.SphereGeometry(1.5,24,16),new T.MeshStandardMaterial({color:0x728f96,roughness:.4}));scene.add(mesh);
    const hemi=new T.HemisphereLight(0xccccff,0x555544,.2);scene.add(hemi);
    const lamps=[new T.PointLight(0xffcc88,30,5),new T.PointLight(0x44aaff,10,0)];
    lamps[0].position.set(-2,2,3);lamps[1].position.set(2,-1,1);scene.add(...lamps);
    const spot=new T.SpotLight(0xffffff,50,8,.5,.4);spot.position.set(0,3,3);scene.add(spot,spot.target);
    const results=[];
    for(const state of [0,1,2,3]){
      lamps[0].intensity=state?30:0;lamps[1].intensity=state>1?10:0;spot.intensity=state===3?50:0;
      lamps[0].distance=state===2?1:5;
      r.setRenderTarget(target);r.render(scene,camera);const pixels=new Uint8Array(48*48*4);
      r.readRenderTargetPixels(target,0,0,48,48,pixels);results.push(pixels);
    }
    target.dispose();mesh.geometry.dispose();mesh.material.dispose();r.dispose();r.forceContextLoss();return results;
  };
  const reference=render();optimizeLighting();const actual=render();let maxError=0;
  for(let s=0;s<actual.length;s++)for(let i=0;i<actual[s].length;i++)maxError=Math.max(maxError,Math.abs(actual[s][i]-reference[s][i]));
  assert(maxError<=1,`lighting differs by ${maxError}/255`);
  T.ShaderChunk.lights_fragment_begin=originalLighting;
  const renderer={ratio:2,getPixelRatio(){return this.ratio},setPixelRatio(r){this.ratio=r}};
  const q=new RenderQuality(renderer);q.setMode('auto');q.maxRatio=2;q.minRatio=1;q.setRatio(2);
  for(let i=0;i<800;i++)q.update(1/25,true);
  assert(renderer.ratio===1,'slow machine did not reach resolution floor');
  for(let i=0;i<600;i++)q.update(1/48,true);
  assert(renderer.ratio===1,'resolution oscillates at sustainable FPS');
  for(let i=0;i<1200;i++)q.update(1/60,true);
  assert(renderer.ratio>1,'resolution did not recover with headroom');
  q.setMode('native');const fixed=renderer.ratio;
  for(let i=0;i<800;i++)q.update(1/20,true);
  assert(renderer.ratio===fixed,'native choice overridden');
  return {geometryBytesBefore:before,geometryBytesAfter:bytes(g),lightingMaxPixelError:maxError};
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channel', default=None)
    args = parser.parse_args()
    errors = []
    root = Path(__file__).resolve().parent.parent
    importmap = re.search(r'<script type="importmap">.*?</script>', (root/'index.html').read_text(), re.S).group()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel=args.channel)
        page = browser.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto('http://localhost:8080/assets/characters/CREDITS.md')
        page.set_content('<base href="http://localhost:8080/">'+importmap)
        print(page.evaluate(CHECK), flush=True)
        print('Errors:', errors, flush=True)
        browser.close()
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
