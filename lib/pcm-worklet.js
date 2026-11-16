// 直播聽寫：在音訊執行緒收集聲音（AudioWorklet），每 1 秒傳一包給 content script。
// 以前用 ScriptProcessor，回呼在頁面主執行緒上跑：直播頁有聊天室，主執行緒一忙就來不及處理，
// 實測一半的聲音被丟掉（37 秒只送出 3 段 6 秒的音訊）。這裡收到的每一格都會留下來，主執行緒忙時只是晚一點送到。
class YtlsPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate); // 1 秒
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          // ctxTime：這包最後一個取樣的時間（AudioContext 時鐘），主執行緒用它算出收到時已經延遲多久
          this.port.postMessage({ data: this.buf, ctxTime: currentTime }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ytls-pcm-tap', YtlsPcmTap);
