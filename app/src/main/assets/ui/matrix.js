(() => {
  'use strict';

  class MatrixField {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d', { alpha: true, desynchronized: true });
      this.timer = null;
      this.active = false;
      this.drops = [];
      this.fontSize = 18;
      this.glyphs = '01NOVA01';
      this.lastFrame = 0;
      this.resize = this.resize.bind(this);
      this.visibility = () => this.syncTimer();
      window.addEventListener('resize', this.resize, { passive: true });
      document.addEventListener('visibilitychange', this.visibility);
      this.resize();
    }

    resize() {
      const ratio = 1;
      const bounds = this.canvas.parentElement?.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds?.width || window.innerWidth));
      const height = Math.max(1, Math.floor(bounds?.height || window.innerHeight));
      this.canvas.width = Math.floor(width * ratio);
      this.canvas.height = Math.floor(height * ratio);
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      const columns = Math.min(80, Math.ceil(this.canvas.width / (this.fontSize * 1.5)));
      this.drops = Array.from({ length: columns }, (_, index) => ({
        x: index * this.fontSize * 1.5,
        y: Math.floor(Math.random() * -30)
      }));
      if (this.context) {
        this.context.font = `12px "JetBrains Mono", monospace`;
        this.context.textBaseline = 'top';
      }
    }

    setActive(active) {
      this.active = Boolean(active) && !document.body.classList.contains('reduce-motion') && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!this.active) this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.syncTimer();
    }

    syncTimer() {
      const shouldRun = this.active && !document.hidden && this.context;
      if (shouldRun && !this.timer) this.timer = window.setInterval(() => this.draw(), 110);
      if (!shouldRun && this.timer) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
    }

    draw() {
      if (!this.context) return;
      const ctx = this.context;
      ctx.fillStyle = 'rgba(5, 10, 8, 0.22)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#00f48e';
      for (const drop of this.drops) {
        const glyph = this.glyphs[Math.floor(Math.random() * this.glyphs.length)];
        ctx.fillText(glyph, drop.x, drop.y * this.fontSize);
        if (drop.y * this.fontSize > this.canvas.height && Math.random() > 0.96) drop.y = 0;
        else drop.y += 1;
      }
    }
  }

  window.NovaMatrix = new MatrixField(document.getElementById('matrixCanvas'));
})();
