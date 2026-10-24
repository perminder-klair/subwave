import {measuredClipDurationMs} from './clip-duration.js';

const segmenter=new Intl.Segmenter(undefined,{granularity:'word'});
export function spokenWordCount(text:string):number {
  const spoken=text.replace(/\[[^\]]*\]/gu,' ')
    .replace(/\((?:sigh|laugh|laughs|chuckle|cough|breath|inhale|exhale)\)/giu,' ');
  return [...segmenter.segment(spoken)].filter(segment=>segment.isWordLike).length;
}

export function ttsMeasurements(result:unknown,text:string) {
  if(typeof result!=='string'||!result)return {words:null,audioMs:null};
  return {words:spokenWordCount(text),audioMs:measuredClipDurationMs(result)};
}
