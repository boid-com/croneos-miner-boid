
const path = require('path');
require('dotenv').config({path: path.join(__dirname, '../.env')});
const CONF = require('../miner_config.json');
const colors = require('colors');

const lt = require('long-timeout');
const { Api, JsonRpc, RpcError, Serialize } = require("@jafri/eosjs2");
const {JsSignatureProvider}  = require('@jafri/eosjs2/dist/eosjs-jssig');
const fetch = require("node-fetch");
const { TextEncoder, TextDecoder } = require("util");
if(!process.env.MINER_PK) throw(Error("No private key specified in .env"))
const signatureProvider = new JsSignatureProvider([process.env.MINER_PK]);
//todo randomize order of endpoints
const rpc = new JsonRpc(CONF.rpc_nodes, { fetch });
const api = new Api({
  rpc,
  signatureProvider,
  textDecoder: new TextDecoder(),
  textEncoder: new TextEncoder()
});
api.Serialize = Serialize;

const {oracle_parser} = require('./oracle_parser.js');
const oracle = new oracle_parser(api);

class Miner {

    constructor(streamProvider, options={}){
        this.opt = {
          max_attempts: 10,
          attempt_delay: 250,
          log_error_attempts: false,
          attempt_early: 2500,
          process_initial_state: true
        }
        this.jobs = new Map([]);
        this.opt = Object.assign(this.opt, options);
        this.permissions = [];
        this.miner_paused = false;
        this.init(streamProvider);
    }

    async init(streamProvider){
      await this.validatePoolPermissions();
      if(!this.streamProvider){
        this.streamProvider = new streamProvider();
        this.start_listeners();
      }
      if(this.opt.process_initial_state){
        this.process_initial_table();
      }
    }

    async process_initial_table(){
      this.cronjobs_table_data = [];
      await this.getCronjobsTable();
      console.log(`Process existing cronjobs table (${this.cronjobs_table_data.length})`.grey);
      for(let i = 0; i < this.cronjobs_table_data.length; ++i){

        if(this.cronjobs_table_data[i].auth_bouncer != ""){
          if(!this.permissions.includes(this.cronjobs_table_data[i].auth_bouncer)){
            console.log("[DISCARD]".green, `Miner not authorized to process job (${this.cronjobs_table_data[i].id})`);
            return;
          }
        }
        
        let schedule_data = await this.scheduleExecution(this.cronjobs_table_data[i]);
        if(schedule_data){
          this.jobs.set(this.cronjobs_table_data[i].id, schedule_data );
        }
      }
      this.cronjobs_table_data = [];
    }

    async getCronjobsTable(next_key=''){
        let res = await api.rpc.get_table_rows({
          json: true,
          code: CONF.croneos_contract,
          scope: CONF.scope,
          table: "cronjobs",
          limit: -1,
          lower_bound : next_key
        }).catch(e => {throw new Error(e)});

        if(res && res.rows){
          this.cronjobs_table_data = this.cronjobs_table_data.concat(res.rows);
          if(res.more){
            await this.getCronjobsTable(res.next_key);
          }
        }
    } 

    start_listeners(){
        this.streamProvider.emitter.on('remove', (data) => {
            const id = data.id;
            let job = this.jobs.get(id);
            if(job != undefined){
              lt.clearTimeout(job.timer);
              this.jobs.delete(id);
            }
            else{
              //console.log("Job not found, already deleted.".yellow);
            }
        });
        this.streamProvider.emitter.on('insert', async (data) => {
            if(data.auth_bouncer != ""){
              if(!this.permissions.includes(data.auth_bouncer) ){
                console.log("[DISCARD]".green, `Miner not authorized to process job (${data.id})`);
                return;
              }
            }
            let schedule_data = await this.scheduleExecution(data);
            this.jobs.set(data.id, schedule_data );
        });
        console.log(`Listening for table deltas...`.grey);
    }

    async scheduleExecution(table_delta_insertion){
        //console.log(table_delta_insertion);
        let due_date = Date.parse(table_delta_insertion.due_date + ".000+00:00"); //utc ms ;
        const job_id = table_delta_insertion.id;
    
        const now = new Date().getTime(); //(better use synced chain time)

        let oracle_conf = null;
        if(table_delta_insertion.oracle_srcs.length ){
          oracle_conf = {
            oracle_srcs: table_delta_insertion.oracle_srcs,
            account: table_delta_insertion.actions[0].account,
            name: table_delta_insertion.actions[0].name,
            dummy_data: table_delta_insertion.actions[0].data
          }
        }
        
        if(due_date > now){
            //future job
            console.log("[schedule]".yellow, "job_id:", job_id, "due_date:", table_delta_insertion.due_date);
            let timer =  lt.setTimeout(()=>{
                this.attempt_exec_sequence(job_id);
            }, due_date-now-this.opt.attempt_early);

            return {timer: timer, auth_bouncer: table_delta_insertion.auth_bouncer, oracle_conf: oracle_conf };
        }
        else if(due_date <= now){
          //immediate execution
          let serialized_oracle_response = null;
          if(oracle_conf !== null){
            serialized_oracle_response = await oracle.get(oracle_conf);
            console.log("oracle response ",serialized_oracle_response);
          }
          await this._createTrx(job_id, table_delta_insertion.auth_bouncer, serialized_oracle_response, true);
          return false;
        }
    }

    async attempt_exec_sequence(id){

        console.log("[exec attempt]".magenta, "job_id:", id);

        let job = this.jobs.get(id);
        if(job === undefined){
          console.log("Error starting exec_sequence, job id not found".red);
          return;
        }
        //check if its a oracle job
        let serialized_oracle_response = null;
        if(job.oracle_conf !== null){
          serialized_oracle_response = await oracle.get(job.oracle_conf);
          console.log("oracle response ",serialized_oracle_response);
          // return;
        }

        const exec_trx = await this._createTrx(id, job.auth_bouncer, serialized_oracle_response, false);

        if(exec_trx === false){//miner is paused
          return;
        }

        let stop = false;
        for(let i=0; i < this.opt.max_attempts; ++i){
            if(stop) break;
            api.rpc.push_transaction(exec_trx).then(res =>{
                    console.log("[EXECUTED]".green, "job_id:", id,"block_time:", res.processed.block_time, "trx_id:", res.processed.id );
                    this.jobs.delete(id); //should ALSO receive remove event to delete the job
                    stop = true;
            })
            .catch(e => {
                if (e instanceof RpcError){
                    let error_msg = "custom error";
                    if(e.json){
                      error_msg = e.json.error.details[0].message;
                    }
                    if(this.opt.log_error_attempts){
                        console.log('error attempt', i, error_msg);
                    }
                    if(error_msg.substr(46,3) == '006'){ //006 id doesn't exist in cronjobs table -> already executed
                      this.jobs.delete(id); //should ALSO receive remove event to delete the job
                      stop = true;
                    }
                }
                else{
                    console.log('error', e);
                }
            });
            await new Promise(resolve=>{
                setTimeout(resolve, this.opt.attempt_delay);
            })
        }
    }

    async _createTrx(jobid, auth_bouncer="", oracle_response=null, broadcast=false){
        if(this.miner_paused){
          console.log('[Miner paused]'.yellow, `skipped execution of job ${jobid}`);
          return false;
        };
        let exec_action = {
            account: CONF.croneos_contract,
            name: "exec",
            authorization: [
              {
                actor: CONF.miner_account,
                permission: CONF.miner_auth
              }
            ],
            data: {
              id: jobid,
              executer: CONF.miner_account,
              scope: CONF.scope,
              oracle_response: ""
            }
        }

        if(oracle_response !== null){
          exec_action.data.oracle_response = oracle_response;
        }

        if(auth_bouncer && auth_bouncer!= CONF.miner_account){
          let p = CONF.mining_pool_permissions.find(mpp => mpp.actor = auth_bouncer);
          exec_action.authorization.push(p);
        }

        try {
            const trx = await api.transact(
              {
                actions: [exec_action]
              },
              {
                blocksBehind: 3,
                expireSeconds: 300,
                broadcast: broadcast
              }
            );
            if(broadcast){
              console.log(`[immediate execution] job_id: ${jobid} trx_id: ${trx.processed.id}`.grey);
            }
            else{
              console.log(`[create transaction] job_id: ${jobid}`.grey);
            }
            
            return trx;
          } catch (e) {
            console.log('\nCaught exception: ' + e);
            if (e instanceof RpcError){
              console.log(JSON.stringify(e.json, null, 2));
            }
          }
    }

    async validatePoolPermissions(){
      let pool_perms = CONF.mining_pool_permissions;
      this.permissions.push(CONF.miner_account);
      if(!pool_perms.length){
        console.log("No mining pool permissions set.".yellow);
        return;
      }
      let is_error = false;
      for(let i=0; i< pool_perms.length; ++i){
        let test = await this.isMinerAuthorizedForPool(CONF.miner_account, pool_perms[i] );
        console.log('Validating pool permissions...'.yellow);
        if(!test){
          is_error = true;
          console.log(`${pool_perms[i].actor}@${pool_perms[i].permission}`.red);
        }
        else{
          console.log(`${pool_perms[i].actor}@${pool_perms[i].permission}`.green);
          this.permissions.push(pool_perms[i].actor);
        }
      }

      if(is_error){
        throw `Miner account doesn't have one or more pool permissions.`
      }
    }

    async isMinerAuthorizedForPool(miner, poolperm){
      let res = await api.rpc.get_account(poolperm.actor).catch(e => false);
      if (res) {
        let perm = res.permissions.find(p => p.perm_name==poolperm.permission);
        let permission = perm.required_auth.accounts.find(a => a.permission.actor == miner);
        if(permission){
          return true;
        }
        else{
          return false;
        }
        
      } else {
        throw `Error getting pool account ${poolperm.actor}`;
      }
    }

    pause(){
      this.miner_paused = true;
      console.log(`[Miner paused]`.yellow);

    }

    resume(){
      this.miner_paused = false;
      console.log(`[Miner active]`.green);
    }
    
}

module.exports = {
    Miner
};