import {QUEUE_KINDS} from "../local/fair-work-queue.js";
export const queueLimits=(patches={})=>Object.fromEntries(QUEUE_KINDS.map(kind=>[kind,{
  maxConcurrent:kind==="inspect"?4:1,minIntervalMs:kind==="dispatch"?1000:0,leaseMs:5000,
  backoffMs:10,maxFailures:3,...patches[kind]}]));
