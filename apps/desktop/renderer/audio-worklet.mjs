import {PcmResampler} from './audio-pcm.mjs';

class DualLinkCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.track=options.processorOptions.track;
    this.baseMs=options.processorOptions.baseMs;
    this.resampler=new PcmResampler(sampleRate);
    this.sentSamples=0;
    this.originMs=null;
    this.port.onmessage=event=>{
      if(event.data?.type==='flush'){
        const tail=this.resampler.flush();if(tail)this.send(tail);
        this.port.postMessage({type:'flushed'});
      }
    };
  }
  send(samples){
    const startMs=(this.originMs??this.baseMs)+this.sentSamples/16;
    this.sentSamples+=samples.length;
    this.port.postMessage({type:'pcm',track:this.track,startMs,samples:samples.buffer},[samples.buffer]);
  }
  process(inputs,outputs){
    // Capture nodes must never replay the meeting/microphone to the speakers.
    for(const output of outputs)for(const channel of output)channel.fill(0);
    const channels=inputs[0];if(!channels?.length||!channels[0]?.length)return true;
    if(this.originMs===null)this.originMs=this.baseMs+currentTime*1000;
    const mono=new Float32Array(channels[0].length);let energy=0;
    for(let i=0;i<mono.length;i++){let sample=0;for(const channel of channels)sample+=(channel[i]||0)/channels.length;mono[i]=sample;energy+=sample*sample;}
    const frames=this.resampler.push(mono);for(const frame of frames)this.send(frame);
    if(frames.length)this.port.postMessage({type:'level',track:this.track,level:Math.min(1,Math.sqrt(energy/mono.length)*4)});
    return true;
  }
}
registerProcessor('dual-link-capture',DualLinkCaptureProcessor);
