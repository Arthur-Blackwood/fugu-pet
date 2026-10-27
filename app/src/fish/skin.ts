// Procedural skin for the body, injected into MeshPhysicalMaterial via onBeforeCompile.
// vRef is the undeformed unit-sphere position, so patterns stay glued to the skin while
// the body inflates. Body coordinates from vRef: t = 0 at the snout tip … 1 at the end
// of the tail stalk; a = angle round the body, 0 on top … π on the belly.
//
// Silver-white puffer colouring: olive-grey back with pale spots and dark saddles,
// a silver flank with a bright band along the edge of the back, a white belly with
// fine prickle bases and (when not inflated) loose longitudinal skin folds.

export const BODY_FRAG_HEAD = /* glsl */ `
varying vec3 vRef;
uniform float uTime; uniform float uGill; uniform float uTone; uniform float uHover; uniform float uAngry; uniform float uDim;
uniform float uInflate;
uniform vec3 uEyeL; uniform vec3 uEyeR;
float gRough = 0.0; float gSilver = 0.0; float gBump = 0.0;
vec3 h33(vec3 p){p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));return fract(sin(p)*43758.5453);}
float h13(vec3 p){return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453);}
vec2 worley(vec3 p){vec3 i=floor(p);vec3 f=fract(p);float d=9.0;float id=0.0;
 for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)for(int z=-1;z<=1;z++){
  vec3 g=vec3(float(x),float(y),float(z));vec3 o=h33(i+g);vec3 r=g+o-f;float dd=dot(r,r);
  if(dd<d){d=dd;id=h13(i+g);} }
 return vec2(sqrt(d),id);}
float vnoise(vec3 p){vec3 i=floor(p);vec3 f=fract(p);f=f*f*(3.0-2.0*f);
 float a=h13(i),b=h13(i+vec3(1,0,0)),c=h13(i+vec3(0,1,0)),d=h13(i+vec3(1,1,0));
 float e=h13(i+vec3(0,0,1)),g=h13(i+vec3(1,0,1)),h=h13(i+vec3(0,1,1)),k=h13(i+vec3(1,1,1));
 return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y),mix(mix(e,g,f.x),mix(h,k,f.x),f.y),f.z);}
float fbm(vec3 p){return vnoise(p)*0.5+vnoise(p*2.03+7.1)*0.3+vnoise(p*4.07+3.3)*0.2;}
float caustic(vec3 p,float t){vec3 q=p+vec3(t*0.22,t*0.11,t*0.17);
 float a=vnoise(q*2.0);float b=vnoise(q*2.6+vec3(4.0,t*0.25,1.0));
 return pow(clamp(1.0-abs(a-b)*3.5,0.0,1.0),7.0);}
// Bump from a procedural height (screen-space derivatives; cf. three's perturbNormalArb).
vec3 fuguBump(vec3 pos, vec3 n, float h, float scale){
 vec3 sx=normalize(dFdx(pos)), sy=normalize(dFdy(pos));
 vec3 r1=cross(sy,n), r2=cross(n,sx);
 float det=dot(sx,r1);
 vec2 dh=vec2(dFdx(h),dFdy(h))*scale;
 vec3 grad=sign(det)*(dh.x*r1+dh.y*r2);
 return normalize(abs(det)*n-grad);}
`;

export interface SkinLandmarks { gillT: number; gillA: number; pecT: number; pecA: number }

const f = (v: number) => v.toFixed(4);

export const bodyFragColor = (L: SkinLandmarks) => /* glsl */ `
{
 vec3 r = normalize(vRef);
 float t = acos(clamp(r.x, -1.0, 1.0)) / 3.14159265;
 float a = abs(atan(r.z, r.y + 1e-6));
 float k = uInflate;
 float n1 = fbm(r * 3.1 + 1.7);
 float n2 = vnoise(r * 9.0);
 // pigment boundaries wander a little, like the real thing
 float aw = a + (n1 - 0.5) * 0.55;
 float backM = 1.0 - smoothstep(1.02, 1.36, aw);
 float bellyM = smoothstep(1.7, 2.1, a + (n2 - 0.5) * 0.12);

 vec3 cBack = vec3(0.062, 0.066, 0.046);   // olive grey
 vec3 cFlank = vec3(0.66, 0.68, 0.68);     // silver
 vec3 cBelly = vec3(0.80, 0.795, 0.76);    // white
 vec3 col = mix(cFlank, cBelly, bellyM);
 // a bright silver band where the back meets the flank, from the eye to the tail
 float band = exp(-pow((aw - 1.42) / 0.11, 2.0)) * smoothstep(0.12, 0.22, t);
 col = mix(col, vec3(0.76, 0.78, 0.78), band * 0.5);
 col = mix(col, cBack, backM);
 col *= mix(mix(0.93, 1.05, n2), mix(0.8, 1.15, n2), backM);

 // back: small pale spots on the olive grey, a coarse reticulation
 vec2 w = worley(r * 13.0 + vec3(1.3, 2.1, 0.7));
 float spot = (1.0 - smoothstep(0.2, 0.38, w.x)) * step(0.22, w.y);
 col = mix(col, vec3(0.16, 0.165, 0.13), spot * backM * 0.65 * smoothstep(0.05, 0.12, t));

 // dark saddles across the back: behind the eyes, mid-back, before the dorsal fin, on the stalk
 float sad = exp(-pow((t - 0.28) / 0.04, 2.0));
 sad = max(sad, exp(-pow((t - 0.47) / 0.05, 2.0)));
 sad = max(sad, exp(-pow((t - 0.64) / 0.04, 2.0)) * 0.9);
 sad = max(sad, exp(-pow((t - 0.84) / 0.04, 2.0)) * 0.8);
 sad *= 1.0 - smoothstep(1.15, 1.6, aw + (n1 - 0.5) * 0.5);
 sad *= smoothstep(0.42, 0.62, fbm(r * 6.0 + 3.0) + 0.22);
 col = mix(col, vec3(0.014, 0.015, 0.011), sad * 0.85);
 // a dark blotch above each pectoral fin
 float bl = length(vec2((t - ${f(L.pecT + 0.025)}) / 0.05, (a - ${f(L.pecA - 0.42)}) / 0.2)) + (n2 - 0.5) * 0.5;
 col = mix(col, vec3(0.03, 0.03, 0.026), (1.0 - smoothstep(0.55, 1.0, bl)) * 0.6 * (1.0 - 0.5 * k));

 // eye: a darker socket with a pale rim of skin
 float de = min(distance(r, uEyeL), distance(r, uEyeR));
 col = mix(col, vec3(0.05, 0.048, 0.04), (1.0 - smoothstep(0.14, 0.2, de)) * 0.55);
 col = mix(col, vec3(0.42, 0.42, 0.38), exp(-pow((de - 0.135) / 0.02, 2.0)) * 0.35);

 // belly + flanks: fine prickle bases (fade where they'd be smaller than a pixel)
 vec3 pq = r * 24.0;
 vec2 wp = worley(pq);
 float aa = clamp(1.6 - length(fwidth(pq)) * 1.4, 0.0, 1.0);
 float prM = smoothstep(1.35, 1.8, a) * smoothstep(0.06, 0.1, t) * (1.0 - smoothstep(0.76, 0.84, t)) * aa;
 float pr = 1.0 - smoothstep(0.1, 0.24, wp.x);
 col = mix(col, col * 0.8, pr * prM * 0.45);
 gBump = pr * prM * 0.5;
 // dorsal prickle patch (much fainter)
 float prD = backM * smoothstep(0.12, 0.18, t) * (1.0 - smoothstep(0.5, 0.58, t)) * aa;
 col = mix(col, col * 1.25, pr * prD * 0.3);
 gBump += pr * prD * 0.25;

 // loose skin folds along the belly — they smooth out as the fish inflates
 float fold = sin(a * 26.0 + n1 * 3.0 + t * 4.0);
 float foldM = smoothstep(2.0, 2.5, a) * smoothstep(0.12, 0.2, t) * (1.0 - smoothstep(0.55, 0.68, t)) * (1.0 - k) * aa;
 col *= 1.0 - foldM * (0.5 - 0.5 * fold) * 0.14;
 gBump += foldM * fold * 0.35;

 // gill opening: a small crescent slit in front of the pectoral fin, opening with uGill
 float side = a - ${f(L.gillA)};
 float gx = (t - ${f(L.gillT)}) + 0.35 * side * side;
 float ge = gx * gx / pow(0.003 + 0.006 * uGill, 2.0) + side * side / 0.018;
 col = mix(col, vec3(0.05, 0.045, 0.04), (1.0 - smoothstep(0.5, 1.0, ge)) * 0.55 * (1.0 - 0.6 * k));
 col = mix(col, col * 1.18, exp(-pow((gx + 0.012) / 0.006, 2.0)) * (1.0 - smoothstep(0.6, 1.4, side * side / 0.03)) * 0.5); // lit lip

 // the tail stalk's underside and the snout tip are a little greyer
 col = mix(col, col * vec3(0.8, 0.82, 0.82), smoothstep(0.82, 0.95, t) * bellyM * 0.6);

 // a little volume: the underside and the tail stalk sit in their own shade
 col *= 1.0 - 0.16 * smoothstep(2.2, 3.0, a) * (1.0 - 0.5 * k);
 // faint moving caustics: "it's underwater"
 float cs = caustic(r * 1.7, uTime);
 col += vec3(0.55, 0.8, 0.9) * cs * 0.04 * (1.0 - smoothstep(0.6, 1.6, a));
 col *= mix(0.6, 1.0, uTone);
 // hover: lift the whole skin a little paler
 col = mix(col, col * 1.2 + vec3(0.035, 0.04, 0.04), uHover);
 // angry: flushes red — strongest on the pale belly, dark marks stay dark
 float lum = dot(col, vec3(0.299, 0.587, 0.114));
 col = mix(col, vec3(0.72, 0.09, 0.06) * (0.35 + 1.2 * lum), uAngry * 0.85);
 // settings open: dimmed
 col *= 1.0 - 0.55 * uDim;

 // silver flanks are glossy; the back is duller
 gSilver = mix(mix(1.0, 0.65, bellyM), 0.1, backM) * (1.0 - sad * 0.6);
 gRough = (n2 - 0.5) * 0.14 - 0.14 * gSilver + 0.06 * backM;
 diffuseColor.rgb = col;
}
`;

/** After the normal is set up: prickle/fold bump, then a fake sky reflection for the
 *  silver sheen (a PMREM environment renders black on some GPUs, so no real env map). */
export const BODY_FRAG_NORMAL = /* glsl */ `
 normal = fuguBump(-vViewPosition, normal, gBump, 0.12);
`;

export const BODY_FRAG_SHEEN = /* glsl */ `
{
 vec3 V = normalize(vViewPosition);
 vec3 R = reflect(-V, normal);
 vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
 float h = dot(R, up);
 vec3 sky = mix(vec3(0.05, 0.07, 0.08), vec3(0.85, 0.93, 0.98), smoothstep(-0.25, 0.55, h));
 sky += vec3(1.0, 0.98, 0.94) * pow(max(dot(R, normalize((viewMatrix * vec4(-0.45, 0.75, 0.5, 0.0)).xyz)), 0.0), 18.0) * 0.9;
 float fres = 0.18 + 0.82 * pow(1.0 - clamp(dot(normal, V), 0.0, 1.0), 3.0);
 totalEmissiveRadiance += sky * gSilver * fres * 0.42 * (1.0 - 0.6 * uDim) * (1.0 - 0.7 * uAngry);
}
`;
