class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.queue.push(new Int16Array(event.data));
      }
    };
  }

  process(_, outputs) {
    const output = outputs[0]?.[0];

    if (!output) {
      return true;
    }

    for (let index = 0; index < output.length; index += 1) {
      if (this.queue.length === 0) {
        output[index] = 0;
        continue;
      }

      const frame = this.queue[0];
      output[index] = frame[this.readOffset] / 0x8000;
      this.readOffset += 1;

      if (this.readOffset >= frame.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
