/* gb-audio-worklet.js
 *
 * Procesa el audio en el hilo de audio real (no el principal), evitando los
 * cortes/glitches típicos de generar sonido desde requestAnimationFrame.
 * El hilo principal empuja un trozo de floats por frame de emulación
 * (~735 muestras a 44.1kHz) vía postMessage; aquí los encolamos y los vamos
 * sirviendo muestra a muestra.
 */
class GBAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queueL = [];
    this.queueR = [];
    this.port.onmessage = (e) => {
      const { left, right } = e.data;
      // Límite de seguridad: si el hilo principal se atasca y se acumulan
      // muchos frames, descartamos los más viejos para no acumular latencia.
      if (this.queueL.length > 44100 * 2) {
        this.queueL.length = 0;
        this.queueR.length = 0;
      }
      for (let i = 0; i < left.length; i++) {
        this.queueL.push(left[i]);
        this.queueR.push(right[i]);
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const chL = out[0];
    const chR = out[1] || out[0];
    for (let i = 0; i < chL.length; i++) {
      chL[i] = this.queueL.length ? this.queueL.shift() : 0;
      chR[i] = this.queueR.length ? this.queueR.shift() : 0;
    }
    return true;
  }
}

registerProcessor('gb-audio-processor', GBAudioProcessor);
