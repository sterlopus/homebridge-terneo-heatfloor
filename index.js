let Service, Characteristic;
const packageJson = require('./package.json');
const axios = require('axios');
const TOTP = require('totp.js');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerAccessory('homebridge-terneo-heatfloor', 'TerneoHeatfloor', TerneoHeatfloor);
};

function TerneoHeatfloor(log, config) {
    this.log = log;

    this.name = config.name;
    this.apiroute = normalizeApiRoute(config.ip);
    this.apiEndpoint = this.apiroute + '/api.cgi';
    this.pollInterval = config.pollInterval || 60;
    this.apiTimeout = config.apiTimeout || 5000;

    this.manufacturer = 'Terneo';
    this.serial = config.serial;
    this.auth = config.auth || null;
    this.time_offset = config.time_offset || 0;
    this.model = config.model || packageJson.name;
    this.firmware = config.firmware || packageJson.version;

    this.accessory_type = config.accessory_type || 'thermostat';

    this.minTemp = config.minTemp || 5;
    this.maxTemp = config.maxTemp || 40;

    this.debug = config.debug || false;

    let initialize_message = '[Terneo] [INFO] Accessory initialized';
    if (this.debug) {
        initialize_message += ', debug mode enabled';
    }

    log(initialize_message);

    this.logDebug = function() {
        if (this.debug) {
            log.info(...arguments);
        } else {
            log.debug(...arguments);
        }
    };

    this.lastState = {};
    this.lastReportedBlock = null;
    this.stateUpdatePromise = null;
    this.paramsChanges = {};
    this.$commitParamsChangesPromise = null;
    this.$commitParamsChangesTimeout = null;

    this.$commitParamsChanges = () => {
        if (this.$commitParamsChangesPromise) {
            return this.$commitParamsChangesPromise;
        }

        let params = [];

        Object.keys(this.paramsChanges).forEach((param) => {
            let type_value_pair = this.paramsChanges[param];
            params.push([param, type_value_pair[0], type_value_pair[1]]);
        });

        this.$commitParamsChangesPromise = this.$writeParams(params)
            .then((response) => {
                this.paramsChanges = {};

                if (this.$isWriteApplied(response.data, params)) {
                    this.$scheduleStateUpdatePoll(1000);
                } else {
                    throw new Error(this.$buildWriteFailureMessage(params, response.data));
                }
            })
            .catch((error) => {
                this.log.warn('[Terneo] [WARNING] Commit param changes error:', this.$formatError(error));
            })
            .finally(() => {
                this.$commitParamsChangesPromise = null;
            })
        ;

        return this.$commitParamsChangesPromise;
    };

    this.$stateUpdate = () => {
        if (this.stateUpdatePromise) {
            return this.stateUpdatePromise;
        }

        this.stateUpdatePromise = this.$apiPost({ cmd: 1 })
            .then((response) => {
                if (response.data && response.data.par) {
                    var state = {}, params = {};
                    response.data.par.forEach((item) => {
                        const param_key = item[0];
                        const param_type = item[1];
                        const param_value = item[2];

                        switch (param_type) {
                            case 1:
                                var param_value_int = parseInt(param_value);
                                if (isNaN(param_value_int)) {
                                    param_value_int = -999;
                                }

                                params[param_key] = param_value_int;
                                break;

                            case 7:
                                params[param_key] = param_value === '1';
                                break;

                            default:
                                params[param_key] = param_value;
                                break;
                        }
                    });

                    state['power'] = !params['125'];
                    state['lock'] = params['124'];
                    state['lan_block'] = params['114'];
                    state['cloud_block'] = params['115'];

                    if (!this.serial && response.data.sn) {
                        this.serial = response.data.sn;
                    }

                    return this.$apiPost({ cmd: 4 })
                        .then((response) => {
                            if (response.data['t.1']) {
                                state['current_temperature'] = response.data['t.1'] / 16;
                                state['target_temperature'] = response.data['t.5'] / 16;
                                state['heating'] = response.data['f.0'] === '1';
                                state['block'] = response.data['m.3'];
                                state['work_mode'] = response.data['m.1'];

                                return state;
                            } else {
                                this.logDebug('cmd:4 response', response.data);
                                throw new Error('Response has no telemetry data');
                            }
                        })
                        ;
                } else {
                    this.logDebug('cmd:1 response', response.data);
                    throw new Error('Response has no parameters data');
                }
            })
            .finally(() => {
                this.stateUpdatePromise = null;
            })
        ;

        return this.stateUpdatePromise;
    };

    this.$apiPost = (payload) => {
        return axios.post(this.apiEndpoint, payload, {
            timeout: this.apiTimeout,
            headers: {
                'Content-Type': 'application/json'
            }
        })
            .then((response) => {
                if (!response.data || typeof response.data !== 'object') {
                    throw new Error('Device returned an empty or invalid JSON response');
                }

                if (response.data.error) {
                    throw new Error('Device API error: ' + JSON.stringify(response.data.error));
                }

                return response;
            })
            .catch((error) => {
                throw new Error(this.$formatError(error));
            })
        ;
    };

    this.$buildWritePayload = (params) => {
        if (!this.serial) {
            throw new Error('Serial number is required for write requests');
        }

        var payload = {
            sn: this.serial,
            par: params
        };

        if (this.auth) {
            var start = new Date(2000, 0, 1, 0, 0, 0), now = new Date();
            payload.time = (Math.round((now.getTime() - start.getTime()) / 1000) + this.time_offset) + '';

            const totp = new TOTP(this.auth, 9);
            payload.auth = totp.genOTP();
        }

        return payload;
    };

    this.$writeParams = (params) => {
        if (this.$isLocalWriteBlocked()) {
            return Promise.reject(new Error('Local API writes are blocked by the thermostat (m.3=' + this.lastState['block'] + ', lanBlock=1). Disable bLc/Lan blocking on the device or configure auth.'));
        }

        return this.$apiPost(this.$buildWritePayload(params));
    };

    this.$isLocalWriteBlocked = () => {
        return !this.auth && (this.lastState['block'] === '2' || this.lastState['block'] === '3' || this.lastState['lan_block'] === true);
    };

    this.$parseParams = (data) => {
        var params = {};

        if (!data || !Array.isArray(data.par)) {
            return params;
        }

        data.par.forEach((item) => {
            if (!Array.isArray(item) || item.length < 3) {
                return;
            }

            params[item[0]] = item[2];
        });

        return params;
    };

    this.$isWriteApplied = (data, expectedParams) => {
        if (data && data.success === true) {
            return true;
        }

        var responseParams = this.$parseParams(data);

        if (Object.keys(responseParams).length === 0) {
            return false;
        }

        return expectedParams.every((item) => {
            return responseParams[item[0]] === (item[2] + '');
        });
    };

    this.$buildWriteFailureMessage = (params, data) => {
        var responseParams = this.$parseParams(data);
        var mismatches = params
            .filter((item) => responseParams[item[0]] !== (item[2] + ''))
            .map((item) => 'param ' + item[0] + ' expected ' + item[2] + ', got ' + (responseParams[item[0]] === undefined ? 'missing' : responseParams[item[0]]))
        ;

        var message = 'Device did not apply requested changes';
        if (mismatches.length) {
            message += ': ' + mismatches.join('; ');
        }

        if (this.$isLocalWriteBlocked()) {
            message += '. Local API writes are blocked; disable bLc/Lan blocking or configure auth.';
        }

        return message;
    };

    this.$formatError = (error) => {
        if (!error) {
            return 'Unknown error';
        }

        if (error.response) {
            return 'HTTP ' + error.response.status + ' from ' + this.apiEndpoint + ': ' + JSON.stringify(error.response.data);
        }

        if (error.code === 'ECONNABORTED') {
            return 'Timeout after ' + this.apiTimeout + ' ms while connecting to ' + this.apiEndpoint;
        }

        if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
            return 'Cannot connect to ' + this.apiEndpoint + ' (' + error.code + ')';
        }

        return error.message || String(error);
    };

    this.activeCharacteristic = null;
    this.lockPhysicalControlsCharacteristic = null;
    this.currentTemperatureCharacteristic = null;
    this.heatingThresholdTemperature = null;
    this.currentHeaterCoolerStateCharacteristic = null;

    this.$stateUpdatePollTimeout = null;
    this.$scheduleStateUpdatePoll = (timeout) => {
        if (this.$stateUpdatePollTimeout) {
            clearTimeout(this.$stateUpdatePollTimeout);
        }

        this.logDebug('[Terneo] [DEBUG] Schedule new state update after ' + (timeout / 1000) + ' sec.');
        this.$stateUpdatePollTimeout = setTimeout(() => {
            this.$stateUpdatePollTimeout = null;
            this.$startStateUpdatePoll();
        }, timeout);
    };

    this.$startStateUpdatePoll = () => {
        this.logDebug('[Terneo] [DEBUG] Begin state update');

        this.$stateUpdate()
            .then((state) => {
                this.logDebug('[Terneo] [DEBUG] State successfully updated');

                if (state['power'] !== this.lastState['power']) {
                    this.logDebug('[Terneo] [DEBUG] Active change:', state['power'], '/', this.lastState['power']);
                    this.activeCharacteristic.updateValue(state['power'] ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                }

                if (state['lock'] !== this.lastState['lock']) {
                    this.logDebug('[Terneo] [DEBUG] lock change:', state['lock'], '/', this.lastState['lock']);
                    this.lockPhysicalControlsCharacteristic.updateValue(state['lock'] ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
                }

                if (state['current_temperature'] !== this.lastState['current_temperature']) {
                    this.logDebug('[Terneo] [DEBUG] CurrentTemperatureCharacteristic change:', state['current_temperature'], '/', this.lastState['current_temperature']);
                    this.currentTemperatureCharacteristic.updateValue(state['current_temperature']);
                }

                if (state['target_temperature'] !== this.lastState['target_temperature']) {
                    this.logDebug('[Terneo] [DEBUG] HeatingThresholdTemperature change:', state['target_temperature'], '/', this.lastState['target_temperature']);
                    this.heatingThresholdTemperature.updateValue(state['target_temperature']);
                }

                if (state['heating'] !== this.lastState['heating']) {
                    this.logDebug('[Terneo] [DEBUG] heating change:', state['heating'], '/', this.lastState['heating']);
                    if (state['heating']) {
                        this.currentHeaterCoolerStateCharacteristic.updateValue(Characteristic.CurrentHeaterCoolerState.HEATING);
                        //targetHeaterCoolerStateCharacteristic.updateValue(Characteristic.TargetHeaterCoolerState.HEAT);
                    } else {
                        this.currentHeaterCoolerStateCharacteristic.updateValue(Characteristic.CurrentHeaterCoolerState.INACTIVE);
                        //targetHeaterCoolerStateCharacteristic.updateValue(undefined);
                    }
                }

                if (state['work_mode'] !== this.lastState['work_mode']) {
                    //var updated_name = this.name;
                    this.logDebug('[Terneo] [DEBUG] work_mode change:', state['work_mode'], '/', this.lastState['work_mode']);
                }

                switch (state['block']) {
                    case '2':
                    case '3':
                        if (this.lastReportedBlock !== state['block']) {
                            if (this.auth) {
                                this.log.info('[Terneo] [INFO] Local API write blocking is enabled (m.3=' + state['block'] + ', lanBlock=' + state['lan_block'] + '); write requests will use configured auth.');
                            } else {
                                this.log.error('[Terneo] [ERROR] Local API write blocking is enabled (m.3=' + state['block'] + ', lanBlock=' + state['lan_block'] + '). Disable bLc/Lan blocking on the thermostat or configure auth.');
                            }
                            this.lastReportedBlock = state['block'];
                        }
                        break;

                    default:
                        this.lastReportedBlock = null;
                        break;
                }

                this.lastState = state;
            })
            .catch((error) => {
                this.log.warn('[Terneo] [WARNING] State update error:', this.$formatError(error));
            })
            .finally(() => {
                this.$scheduleStateUpdatePoll(this.pollInterval * 1000);
            })
        ;
    };

    let infoService = new Service.AccessoryInformation();
    infoService
        .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
        .setCharacteristic(Characteristic.Model, this.model)
        .setCharacteristic(Characteristic.SerialNumber, this.serial)
        .setCharacteristic(Characteristic.FirmwareRevision, this.firmware)
    ;

    var heaterService = new Service.HeaterCooler(this.name);

    var currentTemperatureCharacteristic = heaterService.getCharacteristic(Characteristic.CurrentTemperature);
    var currentHeaterCoolerStateCharacteristic = heaterService.getCharacteristic(Characteristic.CurrentHeaterCoolerState);

    currentHeaterCoolerStateCharacteristic.setProps({
        validValues: [
            Characteristic.CurrentHeaterCoolerState.INACTIVE,
            Characteristic.CurrentHeaterCoolerState.IDLE,
            Characteristic.CurrentHeaterCoolerState.HEATING
        ]
    });

    var targetHeaterCoolerStateCharacteristic = heaterService.getCharacteristic(Characteristic.TargetHeaterCoolerState);
    targetHeaterCoolerStateCharacteristic.setProps({
        validValues: [
            Characteristic.TargetHeaterCoolerState.HEAT
        ]
    });

    var activeCharacteristic = heaterService.getCharacteristic(Characteristic.Active);
    var lockPhysicalControlsCharacteristic = heaterService.addCharacteristic(Characteristic.LockPhysicalControls);

    var temperatureDisplayUnitsCharacteristic = heaterService.addCharacteristic(Characteristic.TemperatureDisplayUnits);
    temperatureDisplayUnitsCharacteristic.setProps({
        validValues: [ Characteristic.TemperatureDisplayUnits.CELSIUS ]
    });

    temperatureDisplayUnitsCharacteristic.setValue(Characteristic.TemperatureDisplayUnits.CELSIUS);

    var heatingThresholdTemperature = heaterService.getCharacteristic(Characteristic.HeatingThresholdTemperature);

    heatingThresholdTemperature
        .setProps({
            minValue: this.minTemp,
            maxValue: this.maxTemp,
            minStep: 1
        })
        .on('get', (callback) => {
            if (typeof this.lastState['target_temperature'] !== 'undefined') {
                callback(null, this.lastState['target_temperature']);
            } else {
                callback(null, 0);
            }
        })
        .on('set', (value, callback) => {
            this.logDebug('[Terneo] [DEBUG] Set HeatingThresholdTemperature to ' + value + ', type: ' + typeof(value));

            var params = [
                [ 5, 1, value + '' ]
            ];

            if (value <= this.minTemp) {
                params.push([ 2, 2, '0' ]);
            } else {
                params.push([ 2, 2, '1' ]);
            }

            this.$writeParams(params)
                .then((response) => {
                    if (this.$isWriteApplied(response.data, params)) {
                        this.logDebug('[Terneo] [DEBUG] HeatingThresholdTemperature successfully setted to', value);

                        this.lastState['target_temperature'] = value;
                        this.$scheduleStateUpdatePoll(1000);
                        callback();
                    } else {
                        this.log.warn('[Terneo] [WARNING] HeatingThresholdTemperature set failure, response:', response.data);
                        callback(new Error(this.$buildWriteFailureMessage(params, response.data)));
                    }
                })
                .catch((error) => {
                    this.log.warn('[Terneo] [WARNING] HeatingThresholdTemperature set failure:', this.$formatError(error));
                    callback(error)
                })
            ;
        })
    ;

    activeCharacteristic
        .on('set', (value, callback) => {
            this.logDebug('[Terneo] [DEBUG] Set Active to ' + value + ', type: ' + typeof(value));

            var power_on;
            if (value === 1) {
                power_on = true;
            } else if (value === 0) {
                power_on = false;
            }

            if (power_on !== undefined) {
                var params = [
                    [ 125, 7, power_on ? '0' : '1' ]
                ];

                this.$writeParams(params)
                    .then((response) => {
                        if (this.$isWriteApplied(response.data, params)) {
                            this.log.info('[Terneo] [INFO] Active successfully setted to', value);

                            this.lastState['power'] = power_on;
                            this.$scheduleStateUpdatePoll(1000);
                            callback();
                        } else {
                            this.log.warn('[Terneo] [WARNING] Active set failure', response.data);
                            callback(new Error(this.$buildWriteFailureMessage(params, response.data)));
                        }
                    })
                    .catch((error) => {
                        this.log.warn('[Terneo] [WARNING] Active set failure:', this.$formatError(error));
                        callback(error)
                    })
                ;
            } else {
                callback(new Error('Unknown Active value: ' + value + ' (' + typeof(value) + ')'));
            }
        })
    ;

    lockPhysicalControlsCharacteristic
        .on('set', (value, callback) => {
            this.logDebug('[Terneo] [DEBUG] Set LockPhysicalControls to ' + value + ', type: ' + typeof(value));

            var lock_on;
            if (value === 1) {
                lock_on = true;
            } else if (value === 0) {
                lock_on = false;
            }

            if (lock_on !== undefined) {
                var params = [
                    [ 124, 7, lock_on ? '1' : '0' ]
                ];

                this.$writeParams(params)
                    .then((response) => {
                        if (this.$isWriteApplied(response.data, params)) {
                            this.log.info('[Terneo] [INFO] LockPhysicalControls successfully setted to', lock_on);

                            this.lastState['lock'] = lock_on;
                            this.$scheduleStateUpdatePoll(1000);
                            callback();
                        } else {
                            this.log.warn('[Terneo] [WARNING] LockPhysicalControls set failure, reponse:', response.data);
                            callback(new Error(this.$buildWriteFailureMessage(params, response.data)));
                        }
                    })
                    .catch((error) => {
                        this.log.warn('[Terneo] [WARNING] LockPhysicalControls set failure:', this.$formatError(error));
                        callback(error)
                    })
                ;
            } else {
                callback(new Error('Unknown LockPhysicalControls value: ' + value + ' (' + typeof(value) + ')'));
            }
        })
    ;

    targetHeaterCoolerStateCharacteristic.setValue(Characteristic.TargetHeaterCoolerState.HEAT);

    this.activeCharacteristic = activeCharacteristic;
    this.lockPhysicalControlsCharacteristic = lockPhysicalControlsCharacteristic;
    this.currentTemperatureCharacteristic = currentTemperatureCharacteristic;
    this.currentHeaterCoolerStateCharacteristic = currentHeaterCoolerStateCharacteristic;
    this.heatingThresholdTemperature = heatingThresholdTemperature;

    this.heaterService = heaterService;
    this.informationService = infoService;
}

TerneoHeatfloor.prototype = {
    identify: function (callback) {
        //this.log('Identify requested!');
        callback();
    },
    getServices: function () {
        this.$startStateUpdatePoll();
        return [ this.informationService, this.heaterService ];
    }
};

function normalizeApiRoute(ip) {
    if (!ip) {
        return '';
    }

    var route = (ip + '').trim();

    if (!/^https?:\/\//i.test(route)) {
        route = 'http://' + route;
    }

    route = route.replace(/\/api\.(cgi|html)$/i, '');
    route = route.replace(/\/+$/g, '');

    return route;
}
