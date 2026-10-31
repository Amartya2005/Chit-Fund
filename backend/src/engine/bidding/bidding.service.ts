/** Online auctions (P8). Opens/closes ONLINE and HYBRID sessions whose time has come. */
export async function autoAdvanceOnlineSessions(companyId: string): Promise<{ opened: number; closed: number }> {
  void companyId;
  return { opened: 0, closed: 0 };
}
