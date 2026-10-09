import {
  Package, Hammer, Settings, Building2, DollarSign, TrendingUp, Megaphone, Wrench, QrCode,
  LayoutDashboard, BarChart2, CalendarDays, ClipboardList, FolderKanban,
  Database, Users, AlertTriangle, MessageSquare, Lightbulb,
  CheckCircle2, FileText, MapPin, GripVertical, Car, SlidersHorizontal, Home,
} from 'lucide-react'
import { BiRuler, BiSpreadsheet, BiAbacus, BiCommentError, BiUserVoice } from 'react-icons/bi'
import { GrDatabase, GrMap } from 'react-icons/gr'
import droptopLogo from '@/assets/droptop-logo.png'
import reladyneLogo from '@/assets/reladyne-logo.svg'

// Nav icons — shared by the sidebar, the top-bar mega menu and the floating dock.


export const ICONS: Record<string, JSX.Element> = {
  home: <Home className="w-4 h-4 flex-shrink-0" />,
  dashboard: <LayoutDashboard className="w-4 h-4 flex-shrink-0" />,
  'on-hand': <Package className="w-4 h-4 flex-shrink-0" />,
  monthend: <BiAbacus className="w-4 h-4 flex-shrink-0" />,
  weekly: <CalendarDays className="w-4 h-4 flex-shrink-0" />,
  orders: <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'orders-v2': <BiSpreadsheet className="w-4 h-4 flex-shrink-0" />,
  config: <Settings className="w-4 h-4 flex-shrink-0" />,
  'global-config': <Database className="w-4 h-4 flex-shrink-0" />,
  outlier: <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  'outlier-am': <Users className="w-4 h-4 flex-shrink-0" />,
  'outlier-leadership': <TrendingUp className="w-4 h-4 flex-shrink-0" />,
  projects: <FolderKanban className="w-4 h-4 flex-shrink-0" />,
  calendar: <CalendarDays className="w-4 h-4 flex-shrink-0" />,
  issues: <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
  meetings: <MessageSquare className="w-4 h-4 flex-shrink-0" />,
  'feature-requests': <Lightbulb className="w-4 h-4 flex-shrink-0" />,
  tasks: <CheckCircle2 className="w-4 h-4 flex-shrink-0" />,
  forms: <FileText className="w-4 h-4 flex-shrink-0" />,
  users: <Users className="w-4 h-4 flex-shrink-0" />,
  locations: <MapPin className="w-4 h-4 flex-shrink-0" />,
  'location-lookup': <MapPin className="w-4 h-4 flex-shrink-0" />,
  'custom-shop-config': <SlidersHorizontal className="w-4 h-4 flex-shrink-0" />,
  'am-rd-lookup': <BiUserVoice className="w-4 h-4 flex-shrink-0" />,
  'tank-monitors': <BiRuler className="w-4 h-4 flex-shrink-0" />,
  'procurement-deck': <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  grni: <DollarSign className="w-4 h-4 flex-shrink-0" />,
  'cogs-price-check': <DollarSign className="w-4 h-4 flex-shrink-0" />,
  'count-sheet': <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'inventory-alerts': <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
  'exception-reporting': <BiCommentError className="w-4 h-4 flex-shrink-0" />,
  'location-comms': <MessageSquare className="w-4 h-4 flex-shrink-0" />,
  'marketing-planner': <Megaphone className="w-4 h-4 flex-shrink-0" />,
  'customer-heatmap': <GrMap className="w-4 h-4 flex-shrink-0" />,
  'tank-links': <QrCode className="w-4 h-4 flex-shrink-0" />,
  'tank-review': <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'droptop-orders': <FileText className="w-4 h-4 flex-shrink-0" />,
  'droptop-vehicles': <Car className="w-4 h-4 flex-shrink-0" />,
  'droptop-packages': <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'package-mapping': <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'pricing-audit': <DollarSign className="w-4 h-4 flex-shrink-0" />,
  'product-sales-history': <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  'staffing-report': <Users className="w-4 h-4 flex-shrink-0" />,
  'data-connections': <GrDatabase className="w-4 h-4 flex-shrink-0" />,
  mmr: <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  drag: <GripVertical className="w-3 h-3 flex-shrink-0 text-chrome-fg/25" />,
}

// Deliberately bigger than a subitem's own icon (w-4, see ICONS above) — a
// section is the parent of everything under it, so its own icon (used both
// in the full sidebar's section header bar and the collapsed rail's
// per-section launcher button) should read as a size step up, not smaller.
export const SECTION_ICONS: Record<string, JSX.Element> = {
  inventory: <Package className="w-5 h-5 flex-shrink-0 text-sky" />,
  droptop: <img src={droptopLogo} alt="" className="w-5 h-5 flex-shrink-0 object-contain" />,
  'shop-tools': <Wrench className="w-5 h-5 flex-shrink-0 text-sky" />,
  reladyne: <img src={reladyneLogo} alt="" className="w-5 h-5 flex-shrink-0 object-contain" />,
  wip: <Hammer className="w-5 h-5 flex-shrink-0 text-[#E67E22]" />,
  'global-config': <Settings className="w-5 h-5 flex-shrink-0 text-chrome-fg/70" />,
  operations: <Building2 className="w-5 h-5 flex-shrink-0 text-[#E67E22]" />,
  finance: <DollarSign className="w-5 h-5 flex-shrink-0 text-[#2ECC71]" />,
  marketing: <Megaphone className="w-5 h-5 flex-shrink-0 text-[#C0392B]" />,
}
