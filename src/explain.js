// Plain English decision explanations
// Turns structured decision data into human-readable sentences.
// No LLM needed - template-based with context-aware logic.

/**
 * Generate a plain English explanation for a decision.
 *
 * @param {object} run - Run record from the database
 * @param {object} context - Optional additional context (weather, moisture)
 * @returns {string} Human-readable explanation
 */
export function explainDecision(run) {
  if (!run) return '';

  const { decision, reason, total_gallons, total_cost, zones_json, window, shadow } = run;

  // Parse zones if available
  let zones = [];
  try { zones = zones_json ? JSON.parse(zones_json) : []; } catch { /* skip */ }

  const prefix = shadow ? 'In shadow mode, the system decided' : 'The system';
  const timeDesc = describeWindow(window);

  if (decision === 'SKIP') {
    return explainSkip(reason, prefix, timeDesc);
  }

  if (decision === 'WATER') {
    return explainWater(reason, zones, total_gallons, total_cost, prefix, timeDesc);
  }

  return `${prefix} ran ${timeDesc} with result: ${reason}`;
}

function explainSkip(reason, prefix, timeDesc) {
  // Safety conditions
  if (reason.includes('High Wind')) {
    const wind = extractNumber(reason, /(\d+\.?\d*)\s*mph/);
    return `${prefix} not to water ${timeDesc} because wind speeds were ${wind ? wind + ' mph' : 'too high'}. ` +
      `Watering in high wind wastes water through drift and uneven coverage. ` +
      `The system will check again next hour.`;
  }

  if (reason.includes('Recent Rain')) {
    const rain = extractNumber(reason, /(\d+\.?\d*)"/);
    return `${prefix} not to water ${timeDesc} because ${rain ? rain + ' inches of' : ''} rain was recently recorded by your weather station. ` +
      `Your soil already received natural irrigation. The system will re-evaluate at the next scheduled check.`;
  }

  if (reason.includes('Low Temp')) {
    const temp = extractNumber(reason, /(\d+\.?\d*).*F/);
    return `${prefix} not to water ${timeDesc} because the temperature was ${temp ? temp + 'F' : 'below the safety threshold'}. ` +
      `Watering near or below freezing can damage plants and create ice hazards.`;
  }

  // Forecast
  if (reason.includes('Rain Forecasted') || reason.includes('Rain Forecast')) {
    const rain = extractNumber(reason, /(\d+\.?\d*)"/);
    return `${prefix} not to water ${timeDesc} because ${rain ? rain + ' inches of' : 'significant'} rain is forecasted in the next 24 hours. ` +
      `The system is saving water by waiting for natural rainfall.`;
  }

  // Soil moisture
  if (reason.includes('No zones require watering') || reason.includes('No zones need')) {
    return `${prefix} that no zones needed water ${timeDesc}. ` +
      `All zones have sufficient soil moisture above their trigger thresholds. ` +
      `The system will continue monitoring and water when moisture levels drop.`;
  }

  // Budget
  if (reason.includes('gallon limit')) {
    return `${prefix} not to water ${timeDesc} because the daily gallon budget has been reached. ` +
      `This prevents unexpected water costs. The budget resets at midnight.`;
  }

  if (reason.includes('cost limit')) {
    return `${prefix} not to water ${timeDesc} because the daily cost budget has been reached. ` +
      `Today's watering has already used the maximum allowed spending. The budget resets at midnight.`;
  }

  // Emergency cooling
  if (reason.includes('Temp') && reason.includes('below trigger')) {
    const temp = extractNumber(reason, /(\d+\.?\d*)F/);
    const trigger = extractNumber(reason, /trigger\s+(\d+\.?\d*)F/);
    return `${prefix} that emergency cooling wasn't needed ${timeDesc}. ` +
      `The temperature was ${temp ? temp + 'F' : 'below the threshold'}${trigger ? ', which is under the ' + trigger + 'F trigger point' : ''}. ` +
      `The trigger adjusts based on solar radiation, humidity, and wind conditions.`;
  }

  if (reason.includes('Cooling interval')) {
    return `${prefix} to skip emergency cooling ${timeDesc} because a cooling cycle ran recently. ` +
      `The system enforces a minimum interval between cooling runs to prevent overwatering.`;
  }

  if (reason.includes('No lawn zones')) {
    return `${prefix} that no lawn zones needed emergency cooling ${timeDesc}. ` +
      `All lawn zones have adequate moisture to handle the current heat.`;
  }

  // Active rain abort
  if (reason.includes('Active Rain')) {
    return `${prefix} had planned to water ${timeDesc}, but detected active rainfall just before sending the command to your Rachio. ` +
      `The run was aborted to avoid watering during rain. This real-time check happens between the decision and the command.`;
  }

  // Generic fallback
  return `${prefix} not to water ${timeDesc}. Reason: ${reason}.`;
}

function explainWater(reason, zones, gallons, cost, prefix, timeDesc) {
  const zoneCount = zones.length;
  const zoneNames = zones.map(z => z.name).filter(Boolean);
  const zoneList = zoneNames.length > 0
    ? zoneNames.length <= 3
      ? zoneNames.join(', ')
      : `${zoneNames.slice(0, 2).join(', ')}, and ${zoneNames.length - 2} other${zoneNames.length - 2 > 1 ? 's' : ''}`
    : `${zoneCount} zone${zoneCount !== 1 ? 's' : ''}`;

  const gallonStr = gallons > 0 ? `, using approximately ${Math.round(gallons)} gallons` : '';
  const costStr = cost > 0 ? ` ($${cost.toFixed(2)})` : '';

  if (reason.includes('Daily Soil Moisture')) {
    return `${prefix} watered ${zoneList} ${timeDesc} based on the daily soil moisture check${gallonStr}${costStr}. ` +
      `These zones had dropped below their optimal moisture threshold based on yesterday's evapotranspiration and weather conditions.`;
  }

  if (reason.includes('Proactive')) {
    return `${prefix} proactively watered ${zoneList} ${timeDesc}${gallonStr}${costStr}. ` +
      `The forecast shows hot, dry conditions ahead that would push these zones into deficit. ` +
      `By watering now, the system prevents stress before it happens.`;
  }

  if (reason.includes('Emergency Cooling')) {
    const temp = extractNumber(reason, /(\d+\.?\d*)F/);
    return `${prefix} ran an emergency cooling cycle on ${zoneList} ${timeDesc}${gallonStr}${costStr}. ` +
      `${temp ? 'The temperature hit ' + temp + 'F, which ' : 'Extreme heat '}triggered the emergency cooling threshold ` +
      `(adjusted for solar radiation, humidity, and wind). Short cooling runs help prevent heat stress damage to turf.`;
  }

  if (reason.includes('Manual') || reason.includes('manual')) {
    return `A manual watering run was triggered for ${zoneList}${gallonStr}${costStr}. ` +
      `This was requested directly, not by the automated schedule.`;
  }

  // Generic water explanation
  return `${prefix} watered ${zoneList} ${timeDesc}${gallonStr}${costStr}. Reason: ${reason}.`;
}

function describeWindow(window) {
  switch (window) {
    case 'daily': return 'during the overnight watering window';
    case 'emergency': return 'during the daytime cooling window';
    case 'manual': return 'via manual trigger';
    default: return '';
  }
}

function extractNumber(str, regex) {
  const match = str.match(regex);
  return match ? match[1] : null;
}

/**
 * Generate a short one-line summary for the daily email or dashboard.
 *
 * @param {object} run - Run record
 * @returns {string} One-line summary
 */
export function shortExplanation(run) {
  if (!run) return 'No activity';

  const { decision, reason, total_gallons } = run;

  if (decision === 'SKIP') {
    if (reason.includes('Wind')) return 'Skipped - too windy';
    if (reason.includes('Rain') && reason.includes('Forecast')) return 'Skipped - rain expected';
    if (reason.includes('Rain')) return 'Skipped - recent rain';
    if (reason.includes('Temp') && reason.includes('Low')) return 'Skipped - too cold';
    if (reason.includes('No zones')) return 'All zones have enough moisture';
    if (reason.includes('gallon')) return 'Skipped - daily water budget reached';
    if (reason.includes('cost')) return 'Skipped - daily cost budget reached';
    if (reason.includes('Active Rain')) return 'Aborted - started raining';
    if (reason.includes('Cooling interval')) return 'Cooling interval not elapsed';
    if (reason.includes('trigger')) return 'Not hot enough for emergency cooling';
    return `Skipped: ${reason}`;
  }

  const gal = total_gallons > 0 ? ` (${Math.round(total_gallons)} gal)` : '';
  if (reason.includes('Emergency')) return `Emergency cooling${gal}`;
  if (reason.includes('Proactive')) return `Proactive watering${gal}`;
  if (reason.includes('Manual')) return `Manual watering${gal}`;
  return `Watered${gal}`;
}
