import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.3/build/index.module.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------- Plan-koordinater (pixlar i planritningen) -> meter ----------
const S = 0.01975;
const P = (px, py) => ({ x: (px - 283) * S, z: (py - 992) * S });
const toPx = (x, z) => ({ px: x / S + 283, py: z / S + 992 });
const FLOOR = 0.25, CEIL = 2.75, EYE = 1.62, RADIUS = 0.26;

const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');
const lite = new URLSearchParams(location.search).has('lite');

// ---------- Renderare & scen ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(lite ? 1 : Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 1500);
camera.rotation.order = 'YXZ';

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// Himmel och sol
const sky = new Sky(); sky.scale.setScalar(4500); scene.add(sky);
const su = sky.material.uniforms;
su.turbidity.value = 3.5; su.rayleigh.value = 1.1; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.8;
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(25));
su.sunPosition.value.copy(sunDir);

const center = new THREE.Vector3(7.7, 0, -6.1);
const sun = new THREE.DirectionalLight(0xfff3e2, 2.6);
sun.position.copy(center).addScaledVector(sunDir, 40);
sun.target.position.copy(center);
sun.castShadow = true;
const sm = lite ? 1024 : (isTouch ? 2048 : 4096); sun.shadow.mapSize.set(sm, sm);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 90 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x8a8a78, 0.6));
scene.add(new THREE.AmbientLight(0xfff8ef, 0.55));   // ersätter ljusstudsar inomhus
scene.fog = new THREE.Fog(0xcfdbe4, 80, 600);

// ---------- Procedurella material (mönster räknas i världskoordinater) ----------
const GLSL_LIB = `
varying vec3 vWPos;
float h1(float n){ return fract(sin(n)*43758.5453123); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=h1(dot(i,vec2(1.0,57.0))), b=h1(dot(i+vec2(1,0),vec2(1.0,57.0))), c=h1(dot(i+vec2(0,1),vec2(1.0,57.0))), d=h1(dot(i+vec2(1,1),vec2(1.0,57.0)));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
`;
// Mittdelens tak skärs vid flyglarnas takfall (takdalar): delar som ligger under flygeltaken döljs
const xE = (770 - 283) * S, xW = (579 - 283) * S, t38 = Math.tan(38 * Math.PI / 180);
const VALLEY_CLIP = `if ((vWPos.x > ${xE.toFixed(4)} && vWPos.y < 3.25 + (vWPos.x - ${xE.toFixed(4)}) * ${t38.toFixed(4)}) ||
                        (vWPos.x < ${xW.toFixed(4)} && vWPos.y < 3.25 + (${xW.toFixed(4)} - vWPos.x) * ${t38.toFixed(4)})) discard;`;
const PATTERNS = {
  facade: {
    color: `float pw=fwidth(vWPos.y/0.145); float pf=fract(vWPos.y/0.145); float pg=smoothstep(0.0,max(0.06,pw*1.5),pf);
            float pk=1.0-smoothstep(0.08,0.35,pw);
            diffuseColor.rgb *= mix(1.0, mix(0.58,1.0,pg) * (0.975+0.025*h1(floor(vWPos.y/0.145))), pk) * mix(1.0,0.93,1.0-pk);`,
    normal: `{ float pw=fwidth(vWPos.y/0.145); float pf=fract(vWPos.y/0.145); float pg=mix(1.0,smoothstep(0.0,max(0.06,pw*1.5),pf),1.0-smoothstep(0.08,0.35,pw));
            vec3 upV=normalize((viewMatrix*vec4(0.0,1.0,0.0,0.0)).xyz); normal=normalize(normal-upV*(1.0-pg)*0.9); }`
  },
  roofZ: roofPattern('z', 0.209), roofX: roofPattern('x', 0.154),
  deck: plank(0.145, 2.4, 0.06), floor: plank(0.18, 2.0, 0.025),
  tile: {
    color: `vec2 tq=fract(vWPos.xz/0.3); float tl=smoothstep(0.0,0.015,tq.x)*smoothstep(0.0,0.015,1.0-tq.x)*smoothstep(0.0,0.015,tq.y)*smoothstep(0.0,0.015,1.0-tq.y);
            diffuseColor.rgb *= mix(0.72,1.0,tl);`, normal: ''
  },
  grass: {
    color: `float gn=vnoise(vWPos.xz*0.35)*0.6+vnoise(vWPos.xz*2.1)*0.3+vnoise(vWPos.xz*13.0)*0.1;
            diffuseColor.rgb *= mix(vec3(0.78,0.85,0.7),vec3(1.12,1.08,0.95),gn);`, normal: ''
  },
  concrete: { color: `diffuseColor.rgb *= 0.88+0.24*vnoise(vWPos.xz*9.0+vWPos.y*7.0);`, normal: '' }
};
function roofPattern(axis, dz) {
  const av = axis === 'z' ? 'vec3(0.0,0.0,1.0)' : 'vec3(1.0,0.0,0.0)';
  return {
    color: (axis === 'x' ? VALLEY_CLIP : '') + `float rc=fract(vWPos.y/${dz}); float rs=smoothstep(0.0,0.14,rc);
            float ru=vWPos.${axis}/0.30*6.2831853; float rp=abs(sin(ru));
            diffuseColor.rgb *= mix(0.42,1.0,rs)*mix(0.72,1.08,rp);`,
    normal: `{ float rc=fract(vWPos.y/${dz}); float rs=smoothstep(0.0,0.14,rc); float ru=vWPos.${axis}/0.30*6.2831853;
            vec3 aV=normalize((viewMatrix*vec4(${av},0.0)).xyz); vec3 upV=normalize((viewMatrix*vec4(0.0,1.0,0.0,0.0)).xyz);
            normal=normalize(normal + aV*cos(ru)*sign(sin(ru))*0.35 - upV*(1.0-rs)*0.7); }`
  };
}
function plank(w, len, gapDark) {
  return {
    color: `float zi=vWPos.z/${w}; float row=floor(zi); float fz=fract(zi);
            float xi=(vWPos.x+h1(row)*${len.toFixed(2)})/${len.toFixed(2)}; float col=floor(xi); float fx=fract(xi);
            float hh=h1(row*7.13+col*13.7);
            float grain=0.92+0.08*sin(vWPos.x*38.0+sin(vWPos.z*95.0+hh*9.0)*2.2);
            float gap=smoothstep(0.0,${gapDark},fz)*smoothstep(0.0,${gapDark},1.0-fz)*smoothstep(0.0,0.004,fx)*smoothstep(0.0,0.004,1.0-fx);
            diffuseColor.rgb *= mix(0.82,1.14,hh)*grain*mix(0.35,1.0,gap);`, normal: ''
  };
}
function patterned(mat, kind, side) {
  const p = PATTERNS[kind]; if (side !== undefined) mat.side = side;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_LIB)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + p.color)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + p.normal);
  };
  mat.customProgramCacheKey = () => 'pat-' + kind;
  return mat;
}
const std = (hex, rough = 0.6, metal = 0, env = 0.5) =>
  new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough, metalness: metal, envMapIntensity: env });

const MATS = {
  Fasad_vit: patterned(std('#eeece6', 0.8), 'facade'),
  Takpannor_flygel: patterned(std('#2a2928', 0.55, 0, 0.6), 'roofZ'),
  Takpannor_mitt: patterned(std('#2a2928', 0.55, 0, 0.6), 'roofX'),
  Trall: patterned(std('#8f6e4c', 0.8), 'deck'),
  Golv_tra: patterned(std('#b9926a', 0.55), 'floor', THREE.DoubleSide),
  Kakel: patterned(std('#dcdfdf', 0.3), 'tile', THREE.DoubleSide),
  Klinker: patterned(std('#a8a59f', 0.7), 'tile', THREE.DoubleSide),
  Sockel: patterned(std('#77756f', 0.95), 'concrete'),
  Karm_svart: std('#1c1c1d', 0.45),
  Platt_svart: std('#222224', 0.4, 0.5),
  Ytterdorr: std('#1e1f22', 0.4),
  Innerdorr: std('#f3f3f1', 0.5),
  Snickeri_vitt: std('#f1f1ef', 0.5),
  Vagg_insida: std('#f4f3ef', 0.92, 0, 0.7),
  Mobel_tra: std('#9b7451', 0.6),
  Textil: std('#8e9297', 0.95),
  Morkt: std('#2b2b2b', 0.7),
  Glas: new THREE.MeshPhysicalMaterial({ color: 0xdfeef3, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false, envMapIntensity: 1.2 })
};

// ---------- Mark ----------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), patterned(std('#5f7f3c', 0.97, 0, 0.25), 'grass'));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.005; ground.receiveShadow = true; ground.name = 'Mark';
scene.add(ground);

// ---------- Innertak (plant, med valv i vardagsrummet) ----------
const ceilMat = std('#f6f5f1', 0.95, 0, 0.7); ceilMat.emissive = new THREE.Color('#77746e');
const outerPx = [[282,367],[579,367],[579,590],[770,590],[770,515],[1071,515],[1071,994],[770,994],[770,918],[433,918],[433,993],[282,993]];
function ceilingMesh() {
  const shape = new THREE.Shape(outerPx.map(([a, b]) => { const p = P(a, b); return new THREE.Vector2(p.x, p.z); }));
  const hole = new THREE.Path([[778,523],[1063,523],[1063,770],[778,770]].map(([a, b]) => { const p = P(a, b); return new THREE.Vector2(p.x, p.z); }));
  shape.holes.push(hole);
  const g = new THREE.ShapeGeometry(shape); g.rotateX(Math.PI / 2); g.translate(0, CEIL, 0);
  const m = new THREE.Mesh(g, ceilMat); m.name = 'Innertak'; m.receiveShadow = true; return m;
}
function vaultMesh() {      // snedtak i vardagsrummet, följer takfallet (38°)
  const t = Math.tan(THREE.MathUtils.degToRad(38));
  const xw = P(778, 0).x, xe = P(1063, 0).x, xm = (xw + xe) / 2, zN = P(0, 523).z, zS = P(0, 770).z;
  const ym = CEIL + (xm - xw) * t;
  const v = [ xw,CEIL,zN, xm,ym,zN, xm,ym,zS, xw,CEIL,zS,   xm,ym,zN, xe,CEIL,zN, xe,CEIL,zS, xm,ym,zS,   xw,CEIL,zS, xm,ym,zS, xe,CEIL,zS ];
  const idx = [0,1,2, 0,2,3,  4,5,6, 4,6,7,  8,9,10];
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setIndex(idx); g.computeVertexNormals();
  const mat = ceilMat.clone(); mat.side = THREE.DoubleSide;
  const m = new THREE.Mesh(g, mat); m.name = 'Valv'; m.receiveShadow = true; return m;
}
const ceiling = ceilingMesh(), vault = vaultMesh();
scene.add(ceiling, vault);

// ---------- Ladda huset ----------
const COLLIDE = /^(Vaggar|Fasadpanel|Glas|Karmar|Innerdorrar|Ytterdorrar|Altandorr_oppen|Knutbrador|Entretak|Inredning_|Hangrannor)/;
const FLOORS = /^(Golv|Kakel_|Klinker_|Trall|Grund)/;
const ROOFY = /^(Tak_|Gavel_|Vindskivor|Hangrannor)/;
const colliders = [], floors = [ground], roofParts = [ceiling, vault];

const bar = document.querySelector('#progress div');
const startBtn = document.getElementById('start');
new GLTFLoader().load('modell/lb137.glb', (gltf) => {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.name || o.parent?.name || '';
    const mname = o.material?.name;
    if (MATS[mname]) o.material = MATS[mname];
    const glass = mname === 'Glas';
    o.castShadow = !glass; o.receiveShadow = !glass;
    const top = (o.parent && o.parent !== gltf.scene) ? o.parent.name : name;
    if (COLLIDE.test(top) || COLLIDE.test(name)) { o.geometry.computeBoundsTree(); colliders.push(o); }
    if (FLOORS.test(top) || FLOORS.test(name)) { o.geometry.computeBoundsTree(); floors.push(o); }
    if (ROOFY.test(top) || ROOFY.test(name)) roofParts.push(o);
    // undvik z-fighting mellan sockel, golv och kakel som ligger millimeter från varandra
    if (/^(Kakel_|Klinker_)/.test(top) || /^(Kakel_|Klinker_)/.test(name)) o.position.y += 0.008;
  });
  scene.add(gltf.scene);
  buildMinimap();
  bar.style.width = '100%';
  startBtn.disabled = false; startBtn.textContent = 'Gå in';
}, (e) => { if (e.total) bar.style.width = (100 * e.loaded / e.total).toFixed(0) + '%'; },
   (err) => { startBtn.textContent = 'Kunde inte ladda modellen'; console.error(err); });

// ---------- Rum ----------
const ROOMS = [
  ['Sovrum 1', 896,772,1056,978, 975,890, -Math.PI*0.5], ['Bad', 785,872,890,980, 840,935, Math.PI],
  ['Klädkammare', 820,774,891,868, 860,820, 0], ['Vardagsrum', 785,530,1056,768, 960,735, 0.35],
  ['Kök', 570,780,782,906, 700,800, Math.PI], ['Matplats', 570,600,782,780, 690,770, 0],
  ['Garderob', 528,770,567,906, 548,840, 0], ['Entré', 422,768,528,906, 480,890, 0],
  ['Hall', 422,692,566,768, 470,740, -Math.PI/2], ['KLV / tvätt', 297,692,418,820, 360,800, 0],
  ['Sovrum 4', 297,825,418,978, 370,940, 0], ['WC / dusch', 478,575,566,688, 520,670, 0],
  ['Allrum', 297,575,476,688, 440,665, Math.PI/2], ['Sovrum 3', 297,383,428,571, 380,520, 0],
  ['Sovrum 2', 432,383,563,571, 480,520, 0], ['Altan', 579,401,1071,598, 700,470, Math.PI],
  ['Entrétrappa', 433,906,580,1000, 486,980, 0]
];
const START = { px: 470, py: 1330, yaw: -0.12 };
const sel = document.getElementById('goto');
ROOMS.forEach(([n], i) => { if (n !== 'Entrétrappa') { const o = document.createElement('option'); o.value = i; o.textContent = n; sel.appendChild(o); } });
const oOut = document.createElement('option'); oOut.value = 'ute'; oOut.textContent = 'Ute, framsidan'; sel.appendChild(oOut);
function roomAt(x, z) {
  const { px, py } = toPx(x, z);
  for (const r of ROOMS) if (px >= r[1] && px <= r[3] && py >= r[2] && py <= r[4]) return r[0];
  return 'Ute';
}

// ---------- Spelaren ----------
const player = { x: 0, z: 0, feet: 0, yaw: 0, pitch: 0 };
function placeAt(px, py, yaw) {
  const p = P(px, py); player.x = p.x; player.z = p.z; player.yaw = yaw; player.pitch = -0.04;
  player.feet = floorHeight(p.x, p.z, 3.0) ?? 0;
}
sel.addEventListener('change', () => {
  if (sel.value === 'ute') placeAt(START.px, START.py, START.yaw);
  else if (sel.value !== '') { const r = ROOMS[+sel.value]; placeAt(r[5], r[6], r[7]); }
  sel.value = ''; if (overview) toggleOverview(); sel.blur();
});

const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const down = new THREE.Vector3(0, -1, 0), tmpO = new THREE.Vector3(), tmpD = new THREE.Vector3();
function floorHeight(x, z, fromY) {
  ray.set(tmpO.set(x, fromY, z), down); ray.far = fromY + 1;
  const h = ray.intersectObjects(floors, false)[0];
  return h ? h.point.y : null;
}
function castH(x, y, z, dx, dz, far) {
  ray.set(tmpO.set(x, y, z), tmpD.set(dx, 0, dz)); ray.far = far;
  return ray.intersectObjects(colliders, false)[0];
}
const DIRS = Array.from({ length: 12 }, (_, i) => [Math.cos(i * Math.PI / 6), Math.sin(i * Math.PI / 6)]);
const nrm = new THREE.Vector3();
function move(dx, dz) {
  const dist = Math.hypot(dx, dz);
  if (dist > 1e-6) {           // klipp rörelsen mot hinder rakt fram
    const ux = dx / dist, uz = dz / dist;
    for (const hy of [0.4, 1.2]) {
      const h = castH(player.x, player.feet + hy, player.z, ux, uz, dist + RADIUS);
      if (h) { const allowed = Math.max(0, h.distance - RADIUS); if (allowed < dist) { dx = ux * allowed; dz = uz * allowed; } }
    }
  }
  let nx = player.x + dx, nz = player.z + dz;
  // nya golvhöjden: trappsteg upp till 0,3 m går bra
  const fh = floorHeight(nx, nz, player.feet + 1.0);
  if (fh !== null && fh - player.feet > 0.3) { nx = player.x; nz = player.z; }
  // knuffa ut ur väggar (ger glidning längs väggen)
  for (let it = 0; it < 2; it++) for (const hy of [0.4, 1.2]) for (const [cx, cz] of DIRS) {
    const h = castH(nx, player.feet + hy, nz, cx, cz, RADIUS);
    if (h && h.face) {
      nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld); nrm.y = 0;
      if (nrm.lengthSq() < 1e-4) continue; nrm.normalize();
      if (nrm.x * cx + nrm.z * cz > 0) nrm.negate();
      const push = RADIUS - h.distance; nx += nrm.x * push; nz += nrm.z * push;
    }
  }
  player.x = nx; player.z = nz;
  const f2 = floorHeight(nx, nz, player.feet + 1.0);
  if (f2 !== null) player.feet += (f2 - player.feet) * (f2 > player.feet ? 0.5 : 0.35);
}

// ---------- Styrning: tangentbord, mus, pekskärm ----------
const keys = {};
addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code.startsWith('Arrow')) e.preventDefault(); });
addEventListener('keyup', (e) => { keys[e.code] = false; });
const intro = document.getElementById('intro'), hint = document.getElementById('hint');
let started = false;
startBtn.addEventListener('click', () => {
  intro.style.display = 'none'; started = true;
  if (!isTouch) canvas.requestPointerLock?.();
  hint.textContent = isTouch ? 'Spaken går · dra på skärmen för att titta' : 'Esc släpper musen';
  setTimeout(() => (hint.style.opacity = 0), 4000);
});
canvas.addEventListener('click', () => { if (started && !isTouch && !overview) canvas.requestPointerLock?.(); });
document.addEventListener('pointerlockchange', () => document.body.classList.toggle('locked', document.pointerLockElement === canvas));
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (Math.abs(e.movementX) > 150 || Math.abs(e.movementY) > 150) return;   // Chrome ger ibland ett jättehopp när musen låses
  player.yaw -= e.movementX * 0.0022; player.pitch -= e.movementY * 0.0022;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
});
// pek: spak för att gå, dra för att titta
const joy = document.getElementById('joy'), knob = joy.firstElementChild; const stick = { id: null, x: 0, y: 0 };
const look = { id: null, x: 0, y: 0 };
joy.addEventListener('pointerdown', (e) => { stick.id = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); });
joy.addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) joyMove(e); });
const joyEnd = (e) => { if (e.pointerId === stick.id) { stick.id = null; stick.x = stick.y = 0; knob.style.transform = ''; } };
joy.addEventListener('pointerup', joyEnd); joy.addEventListener('pointercancel', joyEnd);
function joyMove(e) {
  const r = joy.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  stick.x = x; stick.y = y; knob.style.transform = `translate(${x * 37}px, ${y * 37}px)`;
}
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !overview) { look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; } });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== look.id) return;
  player.yaw -= (e.clientX - look.x) * 0.005; player.pitch -= (e.clientY - look.y) * 0.005;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch)); look.x = e.clientX; look.y = e.clientY;
});
const lookEnd = (e) => { if (e.pointerId === look.id) look.id = null; };
canvas.addEventListener('pointerup', lookEnd); canvas.addEventListener('pointercancel', lookEnd);

// ---------- Översiktsläge (dockskåp: taket borta) ----------
const orbit = new OrbitControls(camera, canvas); orbit.enabled = false; orbit.target.copy(center).setY(1.2);
orbit.maxPolarAngle = Math.PI * 0.47; orbit.minDistance = 6; orbit.maxDistance = 45; orbit.enableDamping = true;
let overview = false;
const roofBtn = document.getElementById('roofbtn');
function toggleOverview() {
  overview = !overview;
  roofParts.forEach((o) => (o.visible = !overview));
  orbit.enabled = overview;
  roofBtn.textContent = overview ? 'Gå runt igen' : 'Visa uppifrån';
  if (overview) { document.exitPointerLock?.(); camera.position.set(center.x - 9, 17, center.z + 16); orbit.update(); }
  joy.style.visibility = overview ? 'hidden' : '';
}
roofBtn.addEventListener('click', () => { toggleOverview(); roofBtn.blur(); });

// ---------- Minikarta (renderas en gång uppifrån, utan tak) ----------
const map = document.getElementById('map'), mctx = map.getContext('2d');
let mapImg = null;
const MAPB = { x0: 7.7 - 8.3, x1: 7.7 + 8.3, z0: -6.1 - 6.9, z1: -6.1 + 6.9 };
function buildMinimap() {
  const W = map.width, H = map.height;
  const cam = new THREE.OrthographicCamera(-8.3, 8.3, 6.9, -6.9, 1, 100);
  cam.position.set(7.7, 40, -6.1); cam.up.set(0, 0, -1); cam.lookAt(7.7, 0, -6.1);
  const rt = new THREE.WebGLRenderTarget(W, H); rt.texture.colorSpace = THREE.SRGBColorSpace;
  roofParts.forEach((o) => (o.visible = false)); sky.visible = false;
  const bg = scene.background; scene.background = new THREE.Color(0xe9e6de); ground.visible = false;
  renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(null);
  const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  const img = mctx.createImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  mctx.putImageData(img, 0, 0);
  mapImg = mctx.getImageData(0, 0, W, H);
  roofParts.forEach((o) => (o.visible = true)); sky.visible = true; scene.background = bg; ground.visible = true; rt.dispose();
}
function drawMap() {
  if (!mapImg) return;
  mctx.putImageData(mapImg, 0, 0);
  const u = (player.x - MAPB.x0) / (MAPB.x1 - MAPB.x0) * map.width, v = (player.z - MAPB.z0) / (MAPB.z1 - MAPB.z0) * map.height;
  mctx.save(); mctx.translate(u, v); mctx.rotate(-player.yaw);
  mctx.fillStyle = 'rgba(47,93,80,.28)'; mctx.beginPath(); mctx.moveTo(0, 0); mctx.arc(0, 0, 38, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); mctx.closePath(); mctx.fill();
  mctx.fillStyle = '#2f5d50'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 2.5;
  mctx.beginPath(); mctx.arc(0, 0, 7, 0, Math.PI * 2); mctx.fill(); mctx.stroke(); mctx.restore();
}

placeAt(START.px, START.py, START.yaw);

// ---------- Huvudloop ----------
const roomEl = document.getElementById('room');
let last = performance.now(), lastRoom = '';
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!overview) {
    let f = 0, s = 0;
    if (keys.KeyW || keys.ArrowUp) f += 1; if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyD || keys.ArrowRight) s += 1; if (keys.KeyA || keys.ArrowLeft) s -= 1;
    if (stick.id !== null) { f -= stick.y; s += stick.x; }
    const l = Math.hypot(f, s);
    if (l > 0.05) {
      const sp = (keys.ShiftLeft || keys.ShiftRight ? 3.2 : 1.6) * Math.min(1, l) * dt; f /= Math.max(1, l); s /= Math.max(1, l);
      const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
      move((-sy * f + cy * s) * sp, (-cy * f - sy * s) * sp);
    } else move(0, 0);
    camera.position.set(player.x, player.feet + EYE, player.z);
    camera.rotation.set(player.pitch, player.yaw, 0);
    const r = roomAt(player.x, player.z); if (r !== lastRoom) { roomEl.textContent = r; lastRoom = r; }
  } else orbit.update();
  drawMap();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// för automatiska tester
window.__visning = { placeAt, toggleOverview, player, camera, move, ready: () => !startBtn.disabled };
