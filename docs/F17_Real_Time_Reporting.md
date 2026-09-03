# F17: Real-Time Reporting Templates

## Overview

F17 implements a **real-time reporting dashboard** (`/analytics` route) for the FinReq system that provides comprehensive insights across all financial requests and approval workflows. This feature displays KPIs, request trends, funding distribution, and approval turnaround times with the ability to filter by time window (Week/Month/Quarter) and export analytics data as CSV.

---

## What We Built

### 1. Analytics Dashboard Route

**Location:** [src/routes/analytics.tsx](src/routes/analytics.tsx)

The analytics page provides a comprehensive reporting interface with:
- **Real-time KPI summary** — displays pending, completed, total requests, and approval rate
- **Time-based filtering** — Week, Month, and Quarter reporting windows
- **Multiple chart visualizations** — bar charts for request trends, pie chart for funding distribution, horizontal bar chart for department turnaround times
- **CSV export functionality** — generates downloadable reports with all request details
- **Responsive design** — works on mobile, tablet, and desktop views

### 2. Data Sources

The dashboard uses a **data fallback strategy**:

```typescript
const { data: requests } = useFinancialRequests();
const sourceRequests = requests.length ? requests : mockRequests;
```

- **Primary:** Real data from the `useFinancialRequests()` hook (Supabase integration)
- **Fallback:** Mock dataset from [src/lib/mock-data.ts](src/lib/mock-data.ts) when no real data exists
- Mock data includes: `mockRequests`, `monthlyData`, `fundingDistribution`, `turnaroundData`

### 3. KPI Metrics

| Metric | Calculation | Purpose |
|--------|-------------|---------|
| **Pending** | Requests with status "Submitted" or "Under Review" | Track items awaiting action |
| **Completed** | Requests with status "Completed" or "Approved" | Measure processed requests |
| **Avg. Turnaround** | Average days to completion (from mock data) | Monitor SLA performance |
| **Avg. Request Amount** | Mean of all request amounts | Financial planning insights |
| **Approval Rate** | (Approved + Completed) / Total * 100 | Measure approval velocity |
| **Overdue Count** | Requests in "Under Review" status | Highlight escalation needs |

### 4. Reporting Templates

The dashboard provides three pre-built reporting views:

1. **Operational Snapshot**
   - Displays total requests tracked across active review queues
   - Shows trend vs. prior period
   - Icon: Gauge

2. **Funding Mix**
   - Shows approval rate after routing and validation
   - Displays number of funding categories managed
   - Icon: FolderKanban

3. **SLA Watchlist**
   - Shows overdue items requiring intervention
   - Highlights escalation flags
   - Icon: TrendingUp

### 5. Charts and Visualizations

#### Time Window Chart (Bar Chart)
- **Data:** Request submission, approval, and rejection trends
- **Time periods:**
  - **Week:** 4 weeks (W1-W4) with weekly data
  - **Month:** 12 months (Jan-Dec) with monthly data
  - **Quarter:** 4 quarters (Q1-Q4) with quarterly data
- **Metrics tracked:** Submitted, Approved, Rejected

#### Funding Distribution (Donut Chart)
- **Purpose:** Visualize breakdown of funding sources
- **Categories:** Department, Research, University, and other funding sources
- **Interactive legend** with percentage distribution

#### Department Turnaround (Horizontal Bar Chart)
- **Purpose:** Show average days to approval by department
- **Helps identify:** Which departments have longest approval times
- **Use case:** Resource allocation and process optimization

### 6. Time Window Filtering

Users can switch between reporting periods via dropdown:
```typescript
type WindowKey = "Week" | "Month" | "Quarter";

const [windowKey, setWindowKey] = useState<WindowKey>("Month");
```

- **Default:** Month view
- **Selection:** Dropdown with radio-button style options
- **Updates:** Charts and metrics recalculate dynamically
- **State:** Persists in component state (clears on page reload)

### 7. CSV Export

The **"Export CSV"** button generates a downloadable report:

**Features:**
- Includes header row: Request ID, Requester, Department, Funding Type, Amount, Status, Updated At
- Properly escapes quotes and special characters in CSV format
- Filename format: `financial-report-[window].csv` (e.g., `financial-report-week.csv`)
- Downloads automatically to user's browser default download folder

**Use cases:**
- Send reports to stakeholders
- Import into Excel or analytics tools
- Archive for compliance/audit purposes

---

## Testing Checklist

### ✅ Build & Compilation
- [x] TypeScript compilation succeeds without errors
- [x] All dependencies (recharts, lucide-react, mock-data) resolve correctly
- [x] Path aliases (@/lib) work correctly
- [x] No console errors during build

### ✅ Route Loading
- [ ] Navigate to `/analytics` route loads without errors
- [ ] Page renders with correct title: "Real-Time Reporting Templates"
- [ ] Subtitle appears: "Insights across all financial requests and approval workflows"
- [ ] No JavaScript errors in browser console

### ✅ KPI Display
- [ ] All 4 KPI cards display (Avg. Turnaround, Avg. Request, Pending, Completed)
- [ ] KPI values are numeric and formatted correctly
- [ ] Dollar amounts show commas (e.g., "$25,000")
- [ ] Cards have proper styling and responsive layout

### ✅ Reporting Templates
- [ ] All 3 template cards appear:
  - [x] Operational Snapshot
  - [x] Funding Mix
  - [x] SLA Watchlist
- [ ] Each card shows:
  - [ ] Correct icon
  - [ ] Title and description
  - [ ] Trend indicator with upward arrow
- [ ] Cards render with consistent styling

### ✅ Time Window Selection
- [ ] Dropdown filter displays with current selection
- [ ] **Week option:** Chart updates to show W1-W4 data
- [ ] **Month option:** Chart updates to show Jan-Dec data
- [ ] **Quarter option:** Chart updates to show Q1-Q4 data
- [ ] Chart data updates reactively when selection changes
- [ ] Dropdown maintains accessibility (aria-label present)

### ✅ Bar Chart (Time Window Requests)
- [ ] Chart renders with correct title based on window (e.g., "Month Requests")
- [ ] X-axis shows correct periods (W1-W4, months, or Q1-Q4)
- [ ] Y-axis shows numeric scale
- [ ] Three data series display:
  - [ ] Submitted (blue/chart-1)
  - [ ] Approved (orange/chart-2)
  - [ ] Rejected (red/chart-4)
- [ ] Grid lines visible
- [ ] Tooltip shows on hover with values
- [ ] Chart is responsive and resizes with viewport

### ✅ Pie/Donut Chart (Funding Distribution)
- [ ] Chart renders with title "Funding Distribution"
- [ ] Donut visualization displays with inner and outer radius
- [ ] Multiple colored segments appear (one per funding source)
- [ ] Legend displays below chart with category names and colors
- [ ] Tooltip shows on hover with category and percentage
- [ ] Colors match CSS variables (--color-chart-1 through 5)

### ✅ Horizontal Bar Chart (Department Turnaround)
- [ ] Chart renders with title "Avg. Approval Turnaround by Department (days)"
- [ ] Y-axis shows department names
- [ ] X-axis shows numeric days
- [ ] Bars display with consistent color
- [ ] Grid lines visible
- [ ] Tooltip shows department name and days on hover
- [ ] Chart is responsive to viewport width

### ✅ CSV Export
- [ ] Export CSV button is clickable
- [ ] Click triggers download dialog
- [ ] Filename follows pattern: `financial-report-[window].csv`
- [ ] File opens correctly in Excel or text editor
- [ ] Header row matches spec: Request ID, Requester, Department, Funding Type, Amount, Status, Updated At
- [ ] All request rows are included
- [ ] CSV is properly escaped (quotes handled correctly)

### ✅ Responsive Design
- [ ] Mobile (< 640px): Single column layout
- [ ] Tablet (640px - 1024px): 2-column grid for charts
- [ ] Desktop (> 1024px): Full 3-column layout where applicable
- [ ] Typography is readable at all breakpoints
- [ ] Touch targets (buttons, dropdowns) are adequate for mobile

### ✅ Data Fallback
- [ ] When no Supabase data available, mock data displays
- [ ] Mock data shows realistic financial request values
- [ ] Calculations work correctly with mock dataset

### ✅ Styling & Accessibility
- [ ] Cards have consistent border and shadow styling
- [ ] Color contrast meets WCAG AA standards
- [ ] All interactive elements have hover states
- [ ] Dropdown is keyboard accessible
- [ ] Proper semantic HTML (headings, labels, buttons)

---

## Integration Points

### Dependencies
- **recharts** (v3.x) — charts and visualizations
- **lucide-react** — icons (Gauge, FolderKanban, TrendingUp, Filter, Download, ArrowUpRight)
- **@/lib/mock-data** — fallback dataset
- **@/lib/requests-data** — real request data via useFinancialRequests hook
- **@tanstack/react-router** — route definition

### Data Hooks
```typescript
const { data: requests } = useFinancialRequests();
```

### CSS Variables (Theme)
```css
--color-chart-1 to --color-chart-5  /* Chart colors */
--color-card                         /* Card background */
--color-border                       /* Border color */
--color-muted-foreground            /* Muted text */
--font-display                       /* Display font */
```

---

## Known Limitations & Future Enhancements

### Current Limitations
1. **Time window state:** Clears on page reload (not persisted to URL or localStorage)
2. **Real-time updates:** Dashboard requires manual refresh for updated data
3. **Date range picker:** Only pre-defined windows (Week/Month/Quarter) available
4. **Drill-down:** Cannot click charts to filter request details
5. **Custom date range:** Not available (future enhancement)

### Potential Enhancements
- [ ] Persist time window selection to URL query parameters or localStorage
- [ ] WebSocket integration for real-time data updates
- [ ] Custom date range picker for flexible reporting periods
- [ ] Drill-down capability to view individual requests from charts
- [ ] Department/funding source filters
- [ ] Comparison view (current vs. previous period)
- [ ] Role-based metric visibility
- [ ] PDF export in addition to CSV

---

## Manual Testing Procedure

### Prerequisites
1. Development environment set up (`npm install`)
2. Development server running (`npm run dev`)
3. Browser open and logged in (if auth required)

### Step-by-Step Testing

1. **Navigate to Analytics**
   - Open browser to `http://localhost:5173/analytics`
   - Verify page loads with title "Real-Time Reporting Templates"

2. **Check KPIs**
   - Verify 4 KPI cards appear below title
   - Record values: Pending, Completed, Avg. Turnaround, Avg. Request

3. **Test Time Window Selection**
   - Click dropdown (default: Month)
   - Select "Week" → verify chart updates to W1-W4
   - Select "Quarter" → verify chart updates to Q1-Q4
   - Select "Month" → verify chart returns to Jan-Dec

4. **Test Charts**
   - Hover over bar chart → tooltip appears with values
   - Hover over pie chart → segment highlights with tooltip
   - Hover over horizontal bar chart → bar highlights with tooltip
   - All three charts should be visible and responsive

5. **Test CSV Export**
   - Click "Export CSV" button
   - File downloads to local machine
   - Open file in Excel or text editor
   - Verify header row and data content

6. **Check Responsive Design**
   - Resize browser to mobile width (< 640px)
   - Verify single-column layout
   - Resize to tablet (640-1024px)
   - Verify 2-column layout
   - Resize to desktop (> 1024px)
   - Verify multi-column layout

7. **Verify No Console Errors**
   - Open Developer Tools (F12)
   - Check Console tab for errors
   - Verify "Network" tab shows successful requests

---

## Success Criteria

Feature F17 is considered **working** when:

✅ **All** build checks pass (no TypeScript errors)
✅ Analytics route loads without JavaScript errors
✅ All KPI metrics display with correct values
✅ Time window selection updates charts dynamically
✅ All three charts render and are interactive
✅ CSV export generates valid file with correct data
✅ Responsive design works on mobile/tablet/desktop
✅ No console warnings or errors

---

## Support & Troubleshooting

### Issue: Charts not rendering
- **Solution:** Check browser console for error. Verify recharts library is installed (`npm list recharts`). Clear browser cache and reload.

### Issue: Mock data showing instead of real data
- **Behavior:** Expected when Supabase connection not available or no requests in database
- **Solution:** Check Supabase connection in `useFinancialRequests` hook

### Issue: CSV export filename wrong
- **Solution:** Verify `windowKey` state is updating correctly. Window name should match file suffix.

### Issue: Charts not responsive
- **Solution:** Check ResizeContainer component is working. Verify CSS grid classes are applied. Test in different browsers.

---

## References

- [Recharts Documentation](https://recharts.org/)
- [TanStack Router Documentation](https://tanstack.com/router)
- [Lucide Icons](https://lucide.dev/)
