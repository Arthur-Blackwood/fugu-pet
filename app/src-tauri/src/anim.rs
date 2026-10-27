//! "Zoom out of the fish" open / close animation for the glass windows (panel, bubble).
//!
//! Animates the window content view's Core Animation layer, which holds both the
//! Liquid Glass view and the webview, so everything scales together on the GPU with no
//! re-layout. Scaling is about an arbitrary point (the fish) by animating
//! `transform.scale` together with `transform.translation`: a point q maps to
//! s·q + t, and t = (p − a)(1 − s) keeps p fixed (a = the layer's anchor point).
//! Opening uses a spring; only animations are added, the model layer is never touched,
//! so AppKit's own layout is unaffected. Other platforms just show / hide.

use std::time::Duration;
use tauri::WebviewWindow;

/// Scale the window starts from / shrinks to.
const FROM_SCALE: f64 = 0.06;
/// Close animation length.
pub const CLOSE: Duration = Duration::from_millis(170);

/// Window-local point (logical px, top-left origin) to zoom from. A window can't draw
/// outside its own frame, so a fish beside the window is mapped to the nearest point
/// on the window's edge (pulled in by the corner radius): the window grows out of the
/// side facing the fish instead of being clipped to a sliver.
fn local_anchor(win: &WebviewWindow, screen: (f64, f64)) -> Option<(f64, f64, f64, f64)> {
    const INSET: f64 = 18.0;
    let sf = win.scale_factor().ok()?;
    let pos = win.outer_position().ok()?.to_logical::<f64>(sf);
    let size = win.outer_size().ok()?.to_logical::<f64>(sf);
    let (w, h) = (size.width, size.height);
    let x = (screen.0 - pos.x).clamp(INSET.min(w / 2.0), (w - INSET).max(w / 2.0));
    let y = (screen.1 - pos.y).clamp(INSET.min(h / 2.0), (h - INSET).max(h / 2.0));
    Some((x, y, w, h))
}

/// Show `win`, growing it out of `from` (screen logical coords).
pub fn zoom_in(win: &WebviewWindow, from: (f64, f64)) {
    #[cfg(target_os = "macos")]
    if let Some(local) = local_anchor(win, from) {
        // Attach the animation first, then show, so no full-size frame flashes.
        let w = win.clone();
        let _ = win.run_on_main_thread(move || unsafe {
            if let Ok(ns) = w.ns_window() {
                mac::zoom(ns.cast(), local, true);
            }
            let _ = w.show();
        });
        return;
    }
    let _ = from;
    let _ = win.show();
}

/// Shrink `win` back into `to`, then run `done` (normally: hide it).
pub fn zoom_out(win: &WebviewWindow, to: (f64, f64), done: impl FnOnce() + Send + 'static) {
    #[cfg(target_os = "macos")]
    if let Some(local) = local_anchor(win, to) {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || unsafe {
            if let Ok(ns) = w.ns_window() {
                mac::zoom(ns.cast(), local, false);
            }
        });
        std::thread::spawn(move || {
            std::thread::sleep(CLOSE);
            done();
        });
        return;
    }
    let _ = to;
    done();
}

/// Drop any finished close animation so the next show starts clean.
pub fn reset(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || unsafe {
            if let Ok(ns) = w.ns_window() {
                mac::reset(ns.cast());
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = win;
}

#[cfg(target_os = "macos")]
// Pure Objective-C glue: every call in here is an FFI call.
#[allow(unsafe_op_in_unsafe_fn)]
mod mac {
    use super::FROM_SCALE;
    use objc::{
        class, msg_send,
        runtime::{Object, NO, YES},
        sel, sel_impl,
    };
    use std::ffi::CString;

    type Id = *mut Object;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    unsafe fn ns_string(s: &str) -> Id {
        let c = CString::new(s).unwrap();
        msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
    }
    unsafe fn ns_number(v: f64) -> Id {
        msg_send![class!(NSNumber), numberWithDouble: v]
    }

    unsafe fn content_layer(ns_window: Id) -> Option<(Id, Id)> {
        let content: Id = msg_send![ns_window, contentView];
        if content.is_null() {
            return None;
        }
        let _: () = msg_send![content, setWantsLayer: YES];
        let layer: Id = msg_send![content, layer];
        (!layer.is_null()).then_some((content, layer))
    }

    /// `local`: (x, y from top-left, width, height) in points.
    pub unsafe fn zoom(ns_window: Id, local: (f64, f64, f64, f64), opening: bool) {
        let Some((content, layer)) = content_layer(ns_window) else { return };
        let (lx, ly_top, w, h) = local;
        // Layer space has a bottom-left origin unless the view is flipped.
        let flipped: bool = msg_send![content, isFlipped];
        let py = if flipped { ly_top } else { h - ly_top };
        let a: CGPoint = msg_send![layer, anchorPoint];
        let (tx, ty) = ((lx - a.x * w) * (1.0 - FROM_SCALE), (py - a.y * h) * (1.0 - FROM_SCALE));

        let _: () = msg_send![layer, removeAllAnimations];
        // The window shadow would show the full-size outline before the content
        // arrives; switch it off for the animation.
        let _: () = msg_send![ns_window, setHasShadow: NO];

        let (from, to) = if opening { ((FROM_SCALE, tx, ty, 0.0), (1.0, 0.0, 0.0, 1.0)) } else { ((1.0, 0.0, 0.0, 1.0), (FROM_SCALE, tx, ty, 0.0)) };
        let keys = [("transform.scale", from.0, to.0), ("transform.translation.x", from.1, to.1), ("transform.translation.y", from.2, to.2)];
        let mut settle = 0.0;
        for (key, a, b) in keys {
            let anim: Id = if opening {
                // Slightly under-damped: a soft, Apple-style settle.
                let s: Id = msg_send![class!(CASpringAnimation), animationWithKeyPath: ns_string(key)];
                let _: () = msg_send![s, setMass: 1.0f64];
                let _: () = msg_send![s, setStiffness: 290.0f64];
                let _: () = msg_send![s, setDamping: 25.0f64];
                let d: f64 = msg_send![s, settlingDuration];
                let _: () = msg_send![s, setDuration: d];
                settle = d;
                s
            } else {
                let b: Id = msg_send![class!(CABasicAnimation), animationWithKeyPath: ns_string(key)];
                let _: () = msg_send![b, setDuration: super::CLOSE.as_secs_f64()];
                let ease: Id = msg_send![class!(CAMediaTimingFunction), functionWithName: ns_string("easeIn")];
                let _: () = msg_send![b, setTimingFunction: ease];
                hold_end(b);
                b
            };
            let _: () = msg_send![anim, setFromValue: ns_number(a)];
            let _: () = msg_send![anim, setToValue: ns_number(b)];
            let _: () = msg_send![layer, addAnimation: anim forKey: ns_string(key)];
        }
        // Fade alongside, quicker than the scale.
        let fade: Id = msg_send![class!(CABasicAnimation), animationWithKeyPath: ns_string("opacity")];
        let _: () = msg_send![fade, setFromValue: ns_number(from.3)];
        let _: () = msg_send![fade, setToValue: ns_number(to.3)];
        let _: () = msg_send![fade, setDuration: if opening { 0.16f64 } else { super::CLOSE.as_secs_f64() }];
        if !opening {
            hold_end(fade);
        }
        let _: () = msg_send![layer, addAnimation: fade forKey: ns_string("opacity")];

        if opening {
            // Shadow back once the window has (nearly) reached full size.
            let win = ns_window as usize;
            let delay = (settle * 0.6).max(0.2);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs_f64(delay));
                dispatch_main(move || {
                    let w = win as Id;
                    let _: () = msg_send![w, setHasShadow: YES];
                    let _: () = msg_send![w, invalidateShadow];
                });
            });
        }
    }

    /// Keep the end state of a close animation until the window is hidden.
    unsafe fn hold_end(anim: Id) {
        let _: () = msg_send![anim, setRemovedOnCompletion: NO];
        let _: () = msg_send![anim, setFillMode: ns_string("forwards")];
    }

    pub unsafe fn reset(ns_window: Id) {
        if let Some((_, layer)) = content_layer(ns_window) {
            let _: () = msg_send![layer, removeAllAnimations];
        }
        let _: () = msg_send![ns_window, setHasShadow: YES];
    }

    /// Run on the main thread via GCD.
    fn dispatch_main(f: impl FnOnce() + Send + 'static) {
        unsafe extern "C" {
            static _dispatch_main_q: std::ffi::c_void;
            fn dispatch_async_f(queue: *const std::ffi::c_void, ctx: *mut std::ffi::c_void, work: extern "C" fn(*mut std::ffi::c_void));
        }
        extern "C" fn trampoline(ctx: *mut std::ffi::c_void) {
            let f: Box<Box<dyn FnOnce()>> = unsafe { Box::from_raw(ctx.cast()) };
            f();
        }
        let boxed: Box<Box<dyn FnOnce()>> = Box::new(Box::new(f));
        unsafe { dispatch_async_f(&_dispatch_main_q, Box::into_raw(boxed).cast(), trampoline) };
    }
}
