import { DAY } from "./traffic-metrics";
export interface TrafficSchedule {
  nextTrafficReport?:number;
  trafficSlot?:number;
  trafficRecipientDay?:number;
  trafficRecipients?:string[];
  lastTrafficError?:string|null;
  lastTrafficReportAt?:number;
}
export function trafficSlot(now:number):number {return Math.floor((now+8*3600_000)/DAY)*DAY+4*3600_000;}
export function trafficDue(state:TrafficSchedule,now:number):boolean {
  // First deployment before noon waits; first deployment after noon catches up.
  state.nextTrafficReport??=trafficSlot(now);
  if(now<state.nextTrafficReport)return false;
  const slot=now>=trafficSlot(now)?trafficSlot(now):trafficSlot(now)-DAY;
  // Missed days collapse into one current report, including partial failures.
  state.trafficSlot=slot;
  const day=Math.floor((now+8*3600_000)/DAY);
  if(state.trafficRecipientDay!==day){state.trafficRecipientDay=day;state.trafficRecipients=[];}
  return true;
}
export function trafficComplete(state:TrafficSchedule,now:number):void {
  state.lastTrafficReportAt=now;
  state.nextTrafficReport=(state.trafficSlot??trafficSlot(now))+DAY;
  state.lastTrafficError=null;
}
