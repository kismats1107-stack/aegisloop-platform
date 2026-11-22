#!/bin/bash
# Live Antakya simulation: Gazebo Harmonic + ros_gz bridges + AegisLoop ROS 2 nodes (UAV/UGV controllers, mission authority).
#   bash sim/run_live.sh            headless Gazebo server
#   bash sim/run_live.sh --gui      with the Gazebo GUI
# The web console connects to the mission authority at http://127.0.0.1:8790 (proxied as /api/live).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source /opt/ros/jazzy/setup.bash
source ~/aegisloop_ws/install/setup.bash          # aegisloop_interfaces (FlyRoute / FollowPath actions)
export GZ_PARTITION="${GZ_PARTITION:-aegis_antakya_live}"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-23}"
export GZ_SIM_RESOURCE_PATH="$HERE/models:$HERE/worlds"
WORLD="$HERE/worlds/antakya_live.sdf"
LOG=/tmp/aegis_live; mkdir -p $LOG
pkill -f "antakya_live.sdf" 2>/dev/null; pkill -f "aegis_live.py" 2>/dev/null; pkill -f "parameter_bridge.*aegis_live" 2>/dev/null; sleep 1
if [ "$1" = "--gui" ]; then gz sim -r "$WORLD" > $LOG/gz.log 2>&1 & else gz sim -s -r "$WORLD" > $LOG/gz.log 2>&1 & fi
GZ=$!
ros2 run ros_gz_bridge parameter_bridge --ros-args -r __node:=aegis_live_bridge -p config_file:="$HERE/live/bridge.yaml" > $LOG/bridge.log 2>&1 &
BR=$!
ros2 run ros_gz_bridge parameter_bridge /world/antakya_live/create@ros_gz_interfaces/srv/SpawnEntity \
  /world/antakya_live/remove@ros_gz_interfaces/srv/DeleteEntity /world/antakya_live/set_pose@ros_gz_interfaces/srv/SetEntityPose \
  --ros-args -r __node:=aegis_live_entity_bridge > $LOG/entity_bridge.log 2>&1 &
EB=$!
trap 'kill $GZ $BR $EB 2>/dev/null; pkill -f antakya_live.sdf' EXIT
~/aegisloop_venv/bin/python "$HERE/live/aegis_live.py" --ros-args -p use_sim_time:=true
