import { Router } from "express";

const router = Router();

// Temporary in-memory storage (you can replace later with DB)
let pickups: any[] = [];

// ✅ GET all pickups
router.get("/", (req, res) => {
  res.json(pickups);
});

// ✅ CREATE pickup
router.post("/", (req, res) => {
  const newPickup = {
    id: Date.now().toString(),
    ...req.body,
    createdAt: new Date().toISOString(),
  };

  pickups.push(newPickup);

  res.status(201).json(newPickup);
});

export default router;