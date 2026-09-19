export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = 0;
  }

  update(dt) {
    this.t += dt;
  }

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#0b0a09';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 자리표시용 도형 — 실제 게임 렌더링으로 교체할 것
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = 40 + Math.sin(this.t * 2) * 8;

    ctx.strokeStyle = '#e0b154';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#a8a29e';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Newdanbipubgame', cx, cy + r + 28);
  }
}
