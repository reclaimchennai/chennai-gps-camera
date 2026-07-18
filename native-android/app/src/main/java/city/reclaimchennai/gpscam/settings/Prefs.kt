package city.reclaimchennai.gpscam.settings

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import city.reclaimchennai.gpscam.wm.WatermarkPrefs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.store by preferencesDataStore(name = "settings")

object Prefs {
    private val ADDRESS = booleanPreferencesKey("wm_address")
    private val DIGIPIN = booleanPreferencesKey("wm_digipin")
    private val NOISE = booleanPreferencesKey("wm_noise")
    private val MINIMAP = booleanPreferencesKey("wm_minimap")
    private val POLICE = booleanPreferencesKey("wm_police")
    private val ZONE_WARD = booleanPreferencesKey("wm_zone_ward")
    private val POSITION_TOP = booleanPreferencesKey("wm_top")
    private val CALIBRATION = intPreferencesKey("db_calibration")

    fun watermark(context: Context): Flow<WatermarkPrefs> =
        context.store.data.map { p ->
            WatermarkPrefs(
                showAddress = p[ADDRESS] ?: true,
                showDigipin = p[DIGIPIN] ?: false,
                showNoise = p[NOISE] ?: true,
                showMiniMap = p[MINIMAP] ?: true,
                showPolice = p[POLICE] ?: true,
                showZoneWard = p[ZONE_WARD] ?: true,
                positionTop = p[POSITION_TOP] ?: false,
            )
        }

    fun calibration(context: Context): Flow<Int> =
        context.store.data.map { it[CALIBRATION] ?: 0 }

    suspend fun setWatermark(context: Context, prefs: WatermarkPrefs) {
        context.store.edit { p ->
            p[ADDRESS] = prefs.showAddress
            p[DIGIPIN] = prefs.showDigipin
            p[NOISE] = prefs.showNoise
            p[MINIMAP] = prefs.showMiniMap
            p[POLICE] = prefs.showPolice
            p[ZONE_WARD] = prefs.showZoneWard
            p[POSITION_TOP] = prefs.positionTop
        }
    }

    suspend fun setCalibration(context: Context, value: Int) {
        context.store.edit { it[CALIBRATION] = value }
    }
}
