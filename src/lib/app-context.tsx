import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import type { UserRole } from "./mock-data";

interface AppContextType {
  role: UserRole;
  setRole: (role: UserRole) => void;
}

const AppContext = createContext<AppContextType>({
  role: "requester",
  setRole: () => {},
});

export function AppProvider({ children }: { children: ReactNode }) {
  const { roles } = useAuth();
  const [role, setRole] = useState<UserRole>("admin");

  useEffect(() => {
    if (roles.length > 0 && !roles.includes(role)) {
      setRole(roles[0]);
    }
  }, [role, roles]);

  return (
    <AppContext.Provider value={{ role, setRole }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  return useContext(AppContext);
}
