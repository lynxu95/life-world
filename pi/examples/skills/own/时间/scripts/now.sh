#!/bin/sh
# 示例技能：报本地时间（脚本统一收在技能文件夹里）
TZ="${TZ:-Asia/Shanghai}" date '+%Y-%m-%d %H:%M:%S %A %Z'
