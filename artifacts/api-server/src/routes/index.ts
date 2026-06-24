import { Router, type IRouter } from "express";
import healthRouter from "./health";
import automationRouter from "./automation";

const router: IRouter = Router();

router.use(healthRouter);
router.use(automationRouter);

export default router;
