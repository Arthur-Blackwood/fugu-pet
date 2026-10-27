// Play-mode screen border: a WebGL edge glow in graphite → silver → white. Tones flow
// around the edge, two highlights sweep in opposite directions, small glints twinkle
// along the line, and the whole thing breathes. On entry it lights up from the top
// centre outward with a flash; on exit it fades.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;      // canvas size, device px
uniform float uDpr;
uniform float uTime;    // seconds
uniform float uIntro;   // seconds since play mode started
uniform float uLevel;   // 0..1 overall presence (fade in / out)
const float TAU = 6.2831853;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
// distance between two positions on the unit loop
float loopDist(float a, float b) { return abs(fract(a - b + 0.5) - 0.5); }

void main() {
  vec2 res = uRes / uDpr;
  vec2 p = gl_FragCoord.xy / uDpr - res * 0.5;
  float d = -sdRoundBox(p, res * 0.5, 14.0);          // CSS px inside the edge
  if (d > 110.0) { gl_FragColor = vec4(0.0); return; }
  float u = atan(p.y * res.x, p.x * res.y) / TAU + 0.5; // position around the loop; top centre = 0.75
  float per = 2.0 * (res.x + res.y);                  // perimeter, px
  float t = uTime;

  // Flowing tone (integer frequencies: seamless all the way round).
  float tone = 0.5
    + 0.20 * sin(TAU * (2.0 * u - 0.045 * t))
    + 0.14 * sin(TAU * (3.0 * u + 0.031 * t) + 1.7)
    + 0.09 * sin(TAU * (7.0 * u - 0.12 * t) + 0.4)
    + 0.05 * sin(TAU * (13.0 * u + 0.21 * t) + 2.2);

  // Two broad highlights sweeping round in opposite directions.
  float s1 = exp(-pow(loopDist(u, 0.065 * t) * per / 240.0, 2.0));
  float s2 = exp(-pow(loopDist(u, 0.43 - 0.048 * t) * per / 170.0, 2.0));

  // Entry: the border draws itself both ways from the top centre, led by a flash.
  float k = uIntro / 1.25;
  float fromTop = loopDist(u, 0.75);
  float reveal = 1.0 - smoothstep(0.5 * k - 0.012, 0.5 * k + 0.03, fromTop);
  float flash = exp(-pow((fromTop - 0.5 * k) * per / 90.0, 2.0)) * (1.0 - smoothstep(0.85, 1.15, k)) * 1.8;

  float lum = clamp(tone + 0.8 * s1 + 0.55 * s2 + flash, 0.0, 2.0);

  // Twinkle: a fine flicker on the line, plus glints that drift and sparkle.
  float flick = 0.86 + 0.14 * sin(t * 9.0 + u * 140.0) * sin(t * 6.3 - u * 97.0);
  float glint = 0.0;
  if (d < 12.0) {
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      float dir = hash(fi + 3.3) > 0.5 ? 1.0 : -1.0;
      float pos = fract(hash(fi) + dir * t * (0.004 + 0.012 * hash(fi + 9.1)));
      float tw = pow(max(0.0, sin(t * (1.4 + 2.6 * hash(fi + 5.7)) + fi * 2.1)), 14.0);
      float along = loopDist(u, pos) * per;
      glint += tw * exp(-(along * along * 0.35 + (d - 1.6) * (d - 1.6)) / 6.0);
    }
  }

  vec3 graphite = vec3(0.46, 0.48, 0.52);
  vec3 silver = vec3(0.78, 0.80, 0.84);
  vec3 white = vec3(1.0);
  vec3 col = mix(graphite, silver, smoothstep(0.12, 0.62, lum));
  col = mix(col, white, smoothstep(0.7, 1.3, lum));
  col = mix(col, white, clamp(glint, 0.0, 1.0));

  float breath = 0.84 + 0.16 * sin(t * 1.2) + 0.05 * sin(t * 3.7 + u * 18.0);
  float dd = max(d, 0.0);
  float line = (1.0 - smoothstep(1.2, 3.2, dd)) * (0.7 + 0.3 * min(lum, 1.3));
  float inner = exp(-dd / 6.0) * (0.25 + 0.45 * lum);                // tight bright rim
  float glow = exp(-dd / 18.0) * (0.12 + 0.38 * lum) * breath;       // soft light inward
  float haze = exp(-dd / 46.0) * 0.07 * (0.5 + 0.5 * lum) * breath;  // faint atmosphere
  float a = (line + inner + glow + haze) * flick + glint * 1.5;
  a = clamp(a, 0.0, 1.0) * uLevel * reveal;
  gl_FragColor = vec4(col * a, a); // premultiplied
}
`;

export function createGlow(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = U('uRes'), uDpr = U('uDpr'), uTime = U('uTime'), uIntro = U('uIntro'), uLevel = U('uLevel');

  let dpr = 1;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  addEventListener('resize', resize);
  resize();

  const t0 = performance.now();
  let startedAt = 0, level = 0, target = 0, last = performance.now(), raf = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.5, (now - last) / 1000); last = now; // real time, even at low frame rates
    // ease toward the target: quick in, quicker out
    level += (target - level) * (1 - Math.exp(-(target > level ? 4 : 7) * dt));
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uDpr, dpr);
    gl.uniform1f(uTime, (now - t0) / 1000);
    gl.uniform1f(uIntro, (now - startedAt) / 1000);
    gl.uniform1f(uLevel, level);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (target > 0 || level > 0.003) raf = requestAnimationFrame(frame);
    else { gl.clear(gl.COLOR_BUFFER_BIT); raf = 0; }
  };
  return {
    show(on: boolean) {
      if (on && target === 0) startedAt = performance.now();
      target = on ? 1 : 0;
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    },
  };
}
