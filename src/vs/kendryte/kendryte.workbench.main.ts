//// included by "vs/workbench/workbench.main.ts"

// Misc Services
import 'vs/kendryte/vs/platform/node/nodePathService';
import 'vs/kendryte/vs/platform/node/nodeRequestService';
import 'vs/kendryte/vs/platform/electron-browser/packagesUpdateService';
// Settings sections
import 'vs/kendryte/vs/workbench/config/browser/categoryContribution';
import 'vs/kendryte/vs/workbench/config/electron-browser/pathSettingsContribution';
import 'vs/kendryte/vs/workbench/config/common/openocdSettingsContribution';
import 'vs/kendryte/vs/workbench/config/common/flashSettingsContribution';
import 'vs/kendryte/vs/workbench/config/browser/internalSettingsCategoryContribution';
// Settings Page Patcher
import 'vs/kendryte/vs/workbench/patchSettings2/browser/settingsTreePathcer';
import 'vs/kendryte/vs/workbench/patchSettings2/browser/settingsPage2Pathcer';
// IO Config
import 'vs/kendryte/vs/workbench/fpioaConfig/node/generateorContribution';
import 'vs/kendryte/vs/workbench/fpioaConfig/electron-browser/fpioaContribution';
import 'vs/kendryte/vs/workbench/fpioaConfig/common/packagings/includeAllContribution';
// Serial Devices
import 'vs/kendryte/vs/workbench/serialPort/node/configContribution';
import 'vs/kendryte/vs/workbench/serialPort/node/serialPortService';
import 'vs/kendryte/vs/workbench/serialPort/node/reloadAction';
// Serial Upload
import 'vs/kendryte/vs/workbench/serialPort/upload/node/uploadContribution';
// Serial Monitor
import 'vs/kendryte/vs/workbench/serialPort/electron-browser/serialMonitorPanel';
import 'vs/kendryte/vs/workbench/serialPort/common/serialMonitorActions';
import 'vs/kendryte/vs/workbench/serialPort/electron-browser/actions/register';
// app top menus
import 'vs/kendryte/vs/platform/electron-browser/menuContribution';
import 'vs/kendryte/vs/platform/node/shortcutsContribution';
// cmake
import 'vs/kendryte/vs/workbench/cmake/electron-browser/cmakeContribution';
// Package Manager
import 'vs/kendryte/vs/workbench/packageManager/node/actionsContribution';