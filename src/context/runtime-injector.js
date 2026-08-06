// 兼容旧 import 路径。运行时环境数据现在归“信息注入器”统一负责。
export {
  runRuntimeInformationInjector as runRuntimeInjector,
} from '../injectors/information-injector.js'
