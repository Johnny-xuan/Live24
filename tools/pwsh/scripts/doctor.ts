import { formatDoctor, runDoctor } from "../src/doctor.js";

const report = await runDoctor();
console.log(formatDoctor(report));
if (report.status !== "ok") process.exitCode = 1;
