import { createContext, useContext, useState, type ReactNode } from "react";
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
  const [role, setRole] = useState<UserRole>("admin");
  return (
    <AppContext.Provider value={{ role, setRole }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  return useContext(AppContext);
}
