export type RequestStatus = "Submitted" | "Under Review" | "Approved" | "Rejected" | "Completed";
export type FundingType = "Department" | "R" | "U";
export type UserRole = "requester" | "admin" | "leadership";

export interface FinancialRequest {
  id: string;
  title: string;
  requester: string;
  department: string;
  fundingType: FundingType;
  amount: number;
  status: RequestStatus;
  submittedAt: string;
  updatedAt: string;
  description: string;
  attachments: number;
  priority: "Low" | "Medium" | "High";
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  time: string;
  read: boolean;
  type: "info" | "success" | "warning";
}

export const mockRequests: FinancialRequest[] = [
  { id: "FR-2025-001", title: "Lab Equipment Purchase", requester: "Dr. Sarah Chen", department: "Chemistry", fundingType: "R", amount: 12500, status: "Approved", submittedAt: "2025-04-01", updatedAt: "2025-04-10", description: "Purchase of spectrometer for graduate research lab.", attachments: 2, priority: "High" },
  { id: "FR-2025-002", title: "Conference Travel Grant", requester: "Prof. James Miller", department: "Computer Science", fundingType: "Department", amount: 3200, status: "Under Review", submittedAt: "2025-04-05", updatedAt: "2025-04-08", description: "Travel funding for IEEE conference presentation.", attachments: 1, priority: "Medium" },
  { id: "FR-2025-003", title: "Student Workshop Materials", requester: "Dr. Emily Park", department: "Engineering", fundingType: "U", amount: 850, status: "Submitted", submittedAt: "2025-04-10", updatedAt: "2025-04-10", description: "Materials for undergraduate workshop series.", attachments: 0, priority: "Low" },
  { id: "FR-2025-004", title: "Research Software License", requester: "Dr. Michael Torres", department: "Physics", fundingType: "R", amount: 4800, status: "Completed", submittedAt: "2025-03-15", updatedAt: "2025-04-02", description: "Annual license renewal for MATLAB research cluster.", attachments: 1, priority: "Medium" },
  { id: "FR-2025-005", title: "Office Renovation", requester: "Prof. Linda Zhao", department: "Mathematics", fundingType: "Department", amount: 15000, status: "Rejected", submittedAt: "2025-03-20", updatedAt: "2025-04-01", description: "Renovation of faculty offices in building C.", attachments: 3, priority: "High" },
  { id: "FR-2025-006", title: "Guest Speaker Honorarium", requester: "Dr. Robert Kim", department: "Biology", fundingType: "U", amount: 2000, status: "Approved", submittedAt: "2025-04-02", updatedAt: "2025-04-12", description: "Honorarium for visiting scholar lecture series.", attachments: 0, priority: "Low" },
  { id: "FR-2025-007", title: "Data Center Upgrade", requester: "Dr. Sarah Chen", department: "IT Services", fundingType: "Department", amount: 45000, status: "Under Review", submittedAt: "2025-04-08", updatedAt: "2025-04-14", description: "Server rack expansion and cooling system upgrade.", attachments: 4, priority: "High" },
  { id: "FR-2025-008", title: "Field Research Supplies", requester: "Prof. Anna Wright", department: "Environmental Science", fundingType: "R", amount: 6200, status: "Submitted", submittedAt: "2025-04-14", updatedAt: "2025-04-14", description: "Sampling equipment for wetland research project.", attachments: 1, priority: "Medium" },
];

export const mockNotifications: Notification[] = [
  { id: "n1", title: "New Request Assigned", message: "FR-2025-008 needs your review", time: "2 min ago", read: false, type: "info" },
  { id: "n2", title: "Request Approved", message: "FR-2025-001 has been approved", time: "1 hour ago", read: false, type: "success" },
  { id: "n3", title: "Action Required", message: "FR-2025-007 is awaiting documentation", time: "3 hours ago", read: true, type: "warning" },
  { id: "n4", title: "Status Update", message: "FR-2025-002 moved to Under Review", time: "1 day ago", read: true, type: "info" },
];

export const monthlyData = [
  { month: "Jan", submitted: 12, approved: 10, rejected: 2 },
  { month: "Feb", submitted: 18, approved: 14, rejected: 3 },
  { month: "Mar", submitted: 22, approved: 17, rejected: 4 },
  { month: "Apr", submitted: 15, approved: 11, rejected: 2 },
];

export const fundingDistribution = [
  { name: "Department", value: 35, fill: "var(--color-chart-1)" },
  { name: "Research (R)", value: 42, fill: "var(--color-chart-2)" },
  { name: "University (U)", value: 23, fill: "var(--color-chart-3)" },
];

export const turnaroundData = [
  { department: "Chemistry", days: 5.2 },
  { department: "CS", days: 3.8 },
  { department: "Engineering", days: 6.1 },
  { department: "Physics", days: 4.5 },
  { department: "Biology", days: 3.2 },
  { department: "Math", days: 7.0 },
];
