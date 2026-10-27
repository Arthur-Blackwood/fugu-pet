// Parameter rig: every animation is a set of target values; the rig eases the
// current values toward them each frame and poses the model. No baked keyframes,
// so any state can blend into any other.
import * as THREE from 'three';
import { waveFin, type Fish, type Eye } from './model';
import { settings } from '../settings';

export type LookMode = 'pointer' | 'scan' | 'dart' | 'down' | 'rest' | 'forward' | 'dir';

export interface Targets {
  inflate: number; finFreq: number; finAmp: number; flap: number; tail: number;
  mouth: number; gill: number; tone: number; eyeWide: number;
  yaw: number; pitch: number; roll: number; x: number; y: number; spin: number;
  look: LookMode;
  /** 'dir' look: screen-space direction to look along (x right, y up). */
  lookDir: [number, number];
  /** Swimming body wave: amplitude (body units) and tail beats per second. */
  wag: number; wagFreq: number;
  /** 0…1: red flush (angry), dimming (settings open). */
  angry: number; dim: number;
  /** Spring constants for `inflate` (critically damped by default). */
  stiff: number; damp: number;
}

export function defaultTargets(): Targets {
  return {
    inflate: 0, finFreq: 6.5, finAmp: 0.2, flap: 0.28, tail: 0.05, mouth: 0, gill: 0.5, tone: 1, eyeWide: 1,
    yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, spin: 0, look: 'scan', lookDir: [1, 0], wag: 0, wagFreq: 1, angry: 0, dim: 0, stiff: 55, damp: 2 * Math.sqrt(55),
  };
}

/** Three-quarter view, turned enough toward the viewer that the face and mouth read,
 *  while the flank and both eyes still show. */
export const BASE_YAW = -0.85;

export const approach = (c: number, t: number, rate: number, dt: number) => c + (t - c) * (1 - Math.exp(-rate * dt));

export function createRig(fish: Fish) {
  const C = { inflate: 0, inflateV: 0, finFreq: 6.5, finAmp: 0.2, flap: 0.28, tail: 0.05, mouth: 0, gill: 0.5, tone: 1, yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, eyeWide: 1, angry: 0, dim: 0, wag: 0, wagFreq: 1, wagPhase: 0 };
  const finWhite = new THREE.Color(1, 1, 1), finRed = new THREE.Color(1, 0.42, 0.36);
  /** World-space point the eyes look at in 'pointer' mode (set by the renderer). */
  const lookWorld = new THREE.Vector3(3, 0, 2.5);
  const scanTarget = new THREE.Vector3(3, 0.3, 3);
  let nextScan = 0;

  const _tl = new THREE.Vector3(), _d = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _qt = new THREE.Quaternion(), _perp = new THREE.Vector3();
  const restOffset = new THREE.Vector3(0.8, -0.5, 0), fwdOffset = new THREE.Vector3(3, 0, 0);
  const MAX_EYE_TURN = 0.62;
  function aimEye(e: Eye, T: Targets, dt: number) {
    const d = e.userData, mode = T.look;
    if (mode === 'pointer') { _tl.copy(lookWorld); fish.group.worldToLocal(_tl); }
    else if (mode === 'dir') {
      fish.group.getWorldPosition(_tl);
      _tl.x += T.lookDir[0] * 4; _tl.y += T.lookDir[1] * 4; _tl.z += 1.2;
      fish.group.worldToLocal(_tl);
    }
    else if (mode === 'scan' || mode === 'dart') _tl.copy(scanTarget);
    else if (mode === 'down') _tl.set(3, -2.5, 0);
    else if (mode === 'rest') _tl.copy(e.position).addScaledVector(d.n, 1).add(restOffset);
    else _tl.copy(e.position).add(fwdOffset).addScaledVector(d.n, 1.2);
    _d.copy(_tl).sub(e.position).normalize();
    // clamp gaze to a cone around the socket normal
    const cos = _d.dot(d.n);
    if (cos < Math.cos(MAX_EYE_TURN)) {
      _perp.copy(_d).addScaledVector(d.n, -cos).normalize();
      _d.copy(d.n).multiplyScalar(Math.cos(MAX_EYE_TURN)).addScaledVector(_perp, Math.sin(MAX_EYE_TURN));
    }
    _qt.setFromUnitVectors(_z, _d);
    d.ball.quaternion.slerp(_qt, 1 - Math.exp(-(mode === 'dart' ? 30 : 16) * dt));
  }

  /** Advance current values toward T and pose the model. Returns the clamped inflate. */
  function step(T: Targets, t: number, dt: number, now: number, slowY: boolean) {
    // inflate is a spring so puffing overshoots and wobbles back
    const a = T.stiff * (T.inflate - C.inflate) - T.damp * C.inflateV;
    C.inflateV += a * dt; C.inflate += C.inflateV * dt;
    C.inflate = Math.max(-0.05, Math.min(1.08, C.inflate));
    const k = Math.max(0, Math.min(1, C.inflate));
    fish.applyInflate(k);

    C.finFreq = approach(C.finFreq, T.finFreq, 6, dt); C.finAmp = approach(C.finAmp, T.finAmp, 6, dt);
    C.flap = approach(C.flap, T.flap, 6, dt); C.tail = approach(C.tail, T.tail, 6, dt);
    C.tone = approach(C.tone, T.tone, 6, dt); C.eyeWide = approach(C.eyeWide, T.eyeWide, 6, dt);
    C.mouth = approach(C.mouth, T.mouth, 18, dt); C.gill = approach(C.gill, T.gill, 6, dt);
    C.yaw = approach(C.yaw, T.yaw + T.spin, T.spin ? 14 : 3.2, dt);
    C.pitch = approach(C.pitch, T.pitch, 3.2, dt); C.roll = approach(C.roll, T.roll, 4, dt);
    C.x = approach(C.x, T.x, 9, dt); C.y = approach(C.y, T.y, slowY ? 1.2 : 5, dt);
    C.angry = approach(C.angry, T.angry, 10, dt); C.dim = approach(C.dim, T.dim, 7, dt);

    const g = fish.group;
    g.position.set(C.x, C.y, 0);
    g.rotation.set(C.roll, BASE_YAW + C.yaw, C.pitch);

    // fins: dorsal + anal beat together (main propulsion), pectorals flap, tail is a rudder
    const { fins } = fish, ff = C.finFreq * settings.finSpeed;
    waveFin(fins.dorsal.geo, t, C.finAmp * 0.55, ff * 0.55, 5.5, 0);
    waveFin(fins.anal.geo, t, C.finAmp * 0.55, ff * 0.55, 5.5, Math.PI);
    waveFin(fins.caudal.geo, t, 0.05 + C.tail * 0.12, 1.4 + C.tail * 3, 1.2, 0);
    // body wave while swimming; the tail's own flick fades out as the wave takes over
    C.wag = approach(C.wag, T.wag, 3, dt); C.wagFreq = approach(C.wagFreq, T.wagFreq, 4, dt);
    C.wagPhase = (C.wagPhase + 2 * Math.PI * C.wagFreq * dt) % (2 * Math.PI * 1000);
    const tailBend = fish.applyWag(C.wag, C.wagPhase);
    const flick = Math.sin(t * (2 + C.tail * 6)) * C.tail * 0.55 * Math.max(0, 1 - C.wag * 9);
    fins.caudal.pivot.rotation.y = flick + tailBend;
    waveFin(fins.pecL.geo, t, 0.05, ff, 3, 0); waveFin(fins.pecR.geo, t, 0.05, ff, 3, 0.6);
    fins.pecL.pivot.rotation.y = 0.55 + Math.sin(t * ff * 2 * Math.PI) * C.flap;
    fins.pecR.pivot.rotation.y = -0.55 - Math.sin(t * ff * 2 * Math.PI + 0.6) * C.flap;
    const finShrink = 1 - k * 0.25; // pectorals tuck in on an inflated ball
    fins.pecL.pivot.scale.setScalar(finShrink); fins.pecR.pivot.scale.setScalar(finShrink);

    fish.setMouth(C.mouth);
    fish.uniforms.uTime.value = t; fish.uniforms.uGill.value = C.gill; fish.uniforms.uTone.value = C.tone;
    fish.uniforms.uAngry.value = C.angry; fish.uniforms.uDim.value = C.dim;
    for (const m of fish.finMats) m.color.copy(finWhite).lerp(finRed, C.angry * 0.8).multiplyScalar(1 - 0.55 * C.dim);

    if ((T.look === 'scan' || T.look === 'dart') && now > nextScan) {
      scanTarget.set(2.5 + Math.random() * 1.5, (Math.random() - 0.4) * 1.6, (Math.random() - 0.5) * 3.5);
      nextScan = now + (T.look === 'dart' ? 250 : 1400 + Math.random() * 2200);
    }
    for (const e of fish.eyes) { aimEye(e, T, dt); e.scale.setScalar(C.eyeWide); }
    return k;
  }

  return { C, step, lookWorld };
}

export type Rig = ReturnType<typeof createRig>;
