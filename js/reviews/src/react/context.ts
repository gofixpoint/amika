import { createContext } from "react";
import type { ReviewStore } from "../store/store.js";

export const ReviewStoreContext = createContext<ReviewStore | null>(null);
