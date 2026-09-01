import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const SIZE_MAP = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-2xl",
  "2xl": "max-w-4xl"
};

export default function Modal({
  open,
  onClose,
  title,
  children,
  size = "lg",
  hideClose = false
}) {
  // Lock background scrolling while the modal is up, then restore whatever was
  // there before. Forcing "unset" on close would clobber the lock the mobile
  // nav drawer sets for itself.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Close on Escape, like any dialog.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // Rendered through a portal on <body>. A modal must position against the
  // viewport, and `position: fixed` resolves against the nearest ancestor with
  // a transform/filter/backdrop-filter instead. Pages sit inside animated and
  // blurred containers, so anchoring to the page tree is unreliable by nature —
  // the portal removes the dependency entirely rather than patching each case.
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity animate-fade-in" 
        onClick={onClose} 
      />
      
      {/* Centering wrapper: min-h-full keeps the modal centered while allowing
          the outer container to scroll when content exceeds the viewport. */}
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        {/* Container */}
        <div className={`relative w-full ${SIZE_MAP[size] || SIZE_MAP.lg} glass rounded-[2rem] shadow-2xl animate-fade-in border border-white/10 overflow-hidden flex flex-col max-h-[90vh]`}>
          {title && (
            <div className="flex items-center justify-between px-8 pt-8 pb-4 shrink-0">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-brand-400 mb-1">
                  AAUL
                </p>
                <h2 className="text-xl font-extrabold text-white tracking-tight truncate">
                  {title}
                </h2>
              </div>
              {!hideClose && (
                <button
                  onClick={onClose}
                  className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/5 transition-all"
                >
                  <X size={20} />
                </button>
              )}
            </div>
          )}
          
          {!title && !hideClose && (
            <button
              onClick={onClose}
              className="absolute top-6 right-6 z-10 p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/5 transition-all"
            >
              <X size={20} />
            </button>
          )}

          <div className="px-8 pb-8 pt-4 overflow-y-auto custom-scrollbar">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
