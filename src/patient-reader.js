/**
 * KM ImagePilot Patient Info Reader
 * 
 * Method 1: Read .ihd XML file → get ReadDateTime + Study type
 * Method 2: Match time in Hippa.Log → get Patient Name + ID
 */

const fs = require('fs');
const path = require('path');

const LOG_FOLDER = 'C:\\KonicaMinolta\\Kim\\Server\\Log';

/**
 * Main function — gets patient info for a given .ihd file
 */
function getPatientInfo(ihdPath) {
  const info = {
    patientName: '',
    patientId: '',
    studyType: '',
    readDateTime: '',
    folderName: '',
  };

  try {
    // Step 1: Read .ihd file
    const ihdData = readIhdFile(ihdPath);
    if (ihdData) {
      Object.assign(info, ihdData);
    }

    // Step 2: Match in Hippa.Log using time
    if (info.readDateTime) {
      const logData = findInHippaLog(info.readDateTime);
      if (logData) {
        info.patientName = logData.patientName;
        info.patientId = logData.patientId;
      }
    }

    // Step 3: Build folder name
    info.folderName = buildFolderName(info);

  } catch (e) {
    console.error('getPatientInfo error:', e.message);
  }

  return info;
}

/**
 * Read .ihd XML file
 * Extract: ReadDateTime, Study type (Tag0008_1030), PATIENT_LID
 */
function readIhdFile(ihdPath) {
  if (!fs.existsSync(ihdPath)) return null;

  const content = fs.readFileSync(ihdPath, 'utf8');

  const result = {
    readDateTime: '',
    studyType: '',
    patientLid: '',
    dataItemLid: '',
  };

  // ReadDateTime: <ReadDateTime>2026-06-07T12:18:46.248...</ReadDateTime>
  const dtMatch = content.match(/<ReadDateTime>([^<]+)<\/ReadDateTime>/);
  if (dtMatch) result.readDateTime = dtMatch[1].trim();

  // Study type: <Tag0008_1030>CHEST PA</Tag0008_1030>
  const studyMatch = content.match(/<Tag0008_1030>([^<]+)<\/Tag0008_1030>/);
  if (studyMatch) result.studyType = studyMatch[1].trim();

  // Patient LID
  const patLidMatch = content.match(/<PATIENT_LID>([^<]+)<\/PATIENT_LID>/);
  if (patLidMatch) result.patientLid = patLidMatch[1].trim();

  // Data item LID (file number)
  const dataMatch = content.match(/<DATA_ITEM_LID>([^<]+)<\/DATA_ITEM_LID>/);
  if (dataMatch) result.dataItemLid = dataMatch[1].trim();

  return result;
}

/**
 * Find patient in Hippa.Log by matching date+time
 * 
 * Log format:
 * 2026/06/07 12:18:46.655  CL1(Server)  UniteaUser  Administrator  ACQUISITION  <><PatientID><PatientName><CR><DateTime><SeriesNo>
 * 
 * We match by date (YYYY/MM/DD) and close time (within 5 minutes)
 */
function findInHippaLog(readDateTime) {
  try {
    // Parse readDateTime: "2026-06-07T12:18:46.248..."
    const rdtMatch = readDateTime.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!rdtMatch) return null;

    const [, year, month, day, hour, min] = rdtMatch;
    const logDate = `${year}/${month}/${day}`; // 2026/06/07
    const rdtMinutes = parseInt(hour) * 60 + parseInt(min);

    // Try today's log file first, then yesterday's
    const logFiles = [
      path.join(LOG_FOLDER, `${year}${month}${day}_System.Log`),
      path.join(LOG_FOLDER, 'Hippa.Log'),
    ];

    for (const logFile of logFiles) {
      if (!fs.existsSync(logFile)) continue;

      const result = searchLogFile(logFile, logDate, rdtMinutes);
      if (result) return result;
    }

  } catch (e) {
    console.error('findInHippaLog error:', e.message);
  }

  return null;
}

/**
 * Search a log file for ACQUISITION entry matching date and time
 */
function searchLogFile(logFile, logDate, rdtMinutes) {
  try {
    // Read last 500KB of log (recent entries)
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 500 * 1024);
    const start = stat.size - readSize;

    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, start);
    fs.closeSync(fd);

    const content = buf.toString('utf8', 0, readSize);
    const lines = content.split('\n');

    // Look for ACQUISITION lines on matching date
    // Format: 2026/06/07 12:18:46.655  ...  ACQUISITION  <><PatientID><PatientName><CR><DateTime><SeriesNo>
    const candidates = [];

    for (const line of lines) {
      if (!line.includes(logDate)) continue;
      if (!line.includes('ACQUISITION') && !line.includes('OVERLAY') && !line.includes('MODIFY')) continue;

      // Extract time from line
      const timeMatch = line.match(/\d{4}\/\d{2}\/\d{2}\s+(\d{2}):(\d{2}):\d{2}/);
      if (!timeMatch) continue;

      const lineMinutes = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
      const timeDiff = Math.abs(lineMinutes - rdtMinutes);

      // Within 10 minutes window
      if (timeDiff > 10) continue;

      // Extract patient info from line
      // Pattern: <><PatientID><PatientName><...>
      const patMatch = line.match(/<><([^>]*)><([^>]+)>/);
      if (patMatch && patMatch[2]) {
        candidates.push({
          patientId: patMatch[1].trim(),
          patientName: patMatch[2].trim(),
          timeDiff,
        });
      }
    }

    // Return closest time match
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.timeDiff - b.timeDiff);
      return candidates[0];
    }

  } catch (e) {
    console.error('searchLogFile error:', e.message);
  }

  return null;
}

/**
 * Build safe folder name from patient info
 * Output: "2026-06-07_MR_RAMESH_KUMAR_ID1234_CHEST_PA"
 */
function buildFolderName(info) {
  const parts = [];

  // Date
  if (info.readDateTime) {
    const d = info.readDateTime.match(/(\d{4}-\d{2}-\d{2})/);
    if (d) parts.push(d[1]);
  } else {
    parts.push(new Date().toISOString().split('T')[0]);
  }

  // Patient name — clean special chars
  if (info.patientName) {
    const cleanName = info.patientName
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 25)
      .toUpperCase();
    if (cleanName) parts.push(cleanName);
  }

  // Patient ID
  if (info.patientId) {
    parts.push('ID' + info.patientId);
  } else if (info.patientLid) {
    parts.push('LID' + info.patientLid);
  }

  // Study type
  if (info.studyType) {
    const cleanStudy = info.studyType.replace(/\s+/g, '_').substring(0, 15);
    parts.push(cleanStudy);
  }

  return parts.join('_') || ('XRay_' + Date.now());
}

module.exports = { getPatientInfo, buildFolderName };
