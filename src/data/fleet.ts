// Published manufacturer specifications. Planner limits are deliberately below the maximums.
export interface RobotSpec {
  id: "x500" | "husky";
  name: string;
  maker: string;
  role: string;
  summary: string;
  headline: [string, string][];
  specs: [string, string][];
  planner: [string, string][];
  source: { label: string; url: string };
}

export const HUSKY_PLAN_SPEED = 1.0;   // m/s over urban debris (max 2.0 m/s)
export const X500_CRUISE = 10;         // m/s survey groundspeed
export const X500_ENDURANCE_S = 18 * 60;
export const X500_ALT = 60;            // m AGL survey altitude
export const X500_SWATH = 105;         // m ground swath at survey altitude (≈84° HFOV camera)

export const FLEET: RobotSpec[] = [
  {
    id: "x500",
    name: "Holybro X500 V2",
    maker: "Holybro",
    role: "Aerial reconnaissance",
    summary: "PX4-based quadrotor used for sector coverage, damage grading from imagery and overwatch during ground execution.",
    headline: [["Wheelbase", "500 mm"], ["Hover endurance", "≈ 18 min"], ["Payload", "≈ 1 kg"], ["Autopilot", "PX4"]],
    specs: [["Frame wheelbase", "500 mm"], ["Frame weight", "610 g"], ["Hover endurance", "≈ 18 min, 4S 5000 mAh, no payload"], ["Payload", "≈ 1 kg at 70% throttle"], ["Autopilot", "PX4 (Pixhawk 6C in development kit)"], ["Simulation model", "PX4 Gazebo x500"]],
    planner: [["Survey altitude", `${X500_ALT} m AGL`], ["Survey groundspeed", `${X500_CRUISE} m/s`], ["Ground swath", `${X500_SWATH} m`], ["Return reserve", "25% battery"]],
    source: { label: "Holybro X500 V2 documentation", url: "https://docs.holybro.com/drone-development-kit/px4-development-kit-x500v2" },
  },
  {
    id: "husky",
    name: "Clearpath Husky A300",
    maker: "Clearpath Robotics",
    role: "Ground execution",
    summary: "Rugged four-wheel UGV for payload delivery and close inspection at collapse sites. Ships with ROS 2 Jazzy support.",
    headline: [["Max speed", "2.0 m/s"], ["Payload", "100 kg"], ["Run time", "8 h standard"], ["Ingress", "IP54"]],
    specs: [["Dimensions", "990 × 698 × 381 mm"], ["Weight", "80 kg"], ["Max payload", "100 kg"], ["Max speed", "2.0 m/s"], ["Max climb grade", "30°"], ["Run time", "8 h standard · 16 h upgraded · 24 h extended"], ["Ingress protection", "IP54"], ["ROS", "ROS 2 Jazzy"]],
    planner: [["Route speed", `${HUSKY_PLAN_SPEED.toFixed(1)} m/s over debris`], ["Clearance from collapse", "≥ 6 m"], ["Impassable", "Roads graded Damaged or Destroyed"], ["Approval", "Required per plan version"]],
    source: { label: "Clearpath Husky A300 specifications", url: "https://clearpathrobotics.com/husky-unmanned-ground-vehicle-robot/" },
  },
];
