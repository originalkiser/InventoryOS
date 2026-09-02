// Standalone page for Data Connections — moved out of Inventory Config's
// tab set (2026-09-02) so it's not buried inside a tabbed page named
// "Inventory Config" and gets its own sidebar section instead. The tab
// component itself (DataConnectionsTab.tsx) is unchanged; this is just a
// thin page wrapper.
import { DataConnectionsTab } from './tabs/DataConnectionsTab'

export function DataConnectionsPage() {
  return <DataConnectionsTab />
}
