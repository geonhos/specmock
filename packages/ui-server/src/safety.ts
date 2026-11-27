/** 안전장치(실제 서버에 GET만 보냄) 상태. 메모리에만 두고 서버를 다시 켜거나 다른 서비스를 보면 켜진다(설계 §3). */
export class SafetyStore {
  private system: string | null = null;
  private on = true;
  get(system: string): boolean {
    if (this.system !== system) { this.system = system; this.on = true; }
    return this.on;
  }
  set(system: string, on: boolean): boolean {
    this.system = system; this.on = on;
    return on;
  }
}
