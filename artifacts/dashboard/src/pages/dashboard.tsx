import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetAutomationStatus,
  useStartAutomation,
  useStopAutomation,
  useGetAutomationLogs,
  useGetAutomationSurveys,
  useGetAutomationStats,
  getGetAutomationStatusQueryKey,
  getGetAutomationLogsQueryKey,
  getGetAutomationSurveysQueryKey,
  getGetAutomationStatsQueryKey,
} from "@workspace/api-client-react";
import { Play, Square, Activity, Database, CheckCircle2, XCircle, AlertCircle, Bot, Zap, Clock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";

export function Dashboard() {
  const queryClient = useQueryClient();

  const { data: status } = useGetAutomationStatus({
    query: { refetchInterval: 2000 }
  });

  const { data: logs } = useGetAutomationLogs({}, {
    query: { refetchInterval: 2000 }
  });

  const { data: surveys } = useGetAutomationSurveys();
  const { data: stats } = useGetAutomationStats();

  const startAutomation = useStartAutomation();
  const stopAutomation = useStopAutomation();

  const handleStart = () => {
    startAutomation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAutomationStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAutomationLogsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAutomationSurveysQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAutomationStatsQueryKey() });
      }
    });
  };

  const handleStop = () => {
    stopAutomation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAutomationStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAutomationLogsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAutomationSurveysQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAutomationStatsQueryKey() });
      }
    });
  };

  const isRunning = status?.running;
  
  const getPhaseBadgeColor = (phase: string | undefined) => {
    if (!phase) return "bg-gray-500/20 text-gray-400";
    switch (phase) {
      case "idle": return "bg-gray-500/20 text-gray-400 border-gray-500/30";
      case "logging_in": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "browsing": return "bg-purple-500/20 text-purple-400 border-purple-500/30";
      case "answering": return "bg-primary/20 text-primary border-primary/30";
      case "claiming": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
      case "error": return "bg-destructive/20 text-destructive border-destructive/30";
      default: return "bg-secondary text-secondary-foreground";
    }
  };

  const getLogLevelColor = (level: string) => {
    switch (level) {
      case "info": return "text-blue-400";
      case "success": return "text-primary";
      case "warn": return "text-yellow-400";
      case "error": return "text-destructive";
      default: return "text-muted-foreground";
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border pb-6">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 p-2 rounded-md border border-primary/20">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">BigPesquisa Bot</h1>
              <p className="text-sm text-muted-foreground font-mono">AUTOMATION_CONTROL_PANEL v1.0.0</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">System Status</span>
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3">
                  {isRunning ? (
                    <>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                    </>
                  ) : (
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-muted-foreground"></span>
                  )}
                </span>
                <span className="font-mono text-sm font-semibold">{isRunning ? "ONLINE" : "OFFLINE"}</span>
              </div>
            </div>
          </div>
        </header>

        {/* Hero Status Panel */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="col-span-1 md:col-span-2 bg-card/50 backdrop-blur-sm border-primary/10 shadow-[0_0_20px_rgba(20,180,100,0.05)] relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent pointer-events-none" />
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between items-center uppercase tracking-wider">
                <span>Core Engine</span>
                <Badge variant="outline" className={getPhaseBadgeColor(status?.phase)}>
                  {status?.phase || "UNKNOWN"}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                <div className="flex items-center gap-4 w-full">
                  {isRunning ? (
                    <Button 
                      size="lg" 
                      variant="destructive" 
                      onClick={handleStop}
                      disabled={stopAutomation.isPending}
                      className="w-full sm:w-auto h-16 px-8 text-lg font-bold tracking-widest shadow-[0_0_15px_rgba(220,38,38,0.3)] hover:shadow-[0_0_25px_rgba(220,38,38,0.5)] transition-all"
                    >
                      <Square className="mr-2 h-5 w-5 fill-current" />
                      HALT ENGINE
                    </Button>
                  ) : (
                    <Button 
                      size="lg" 
                      onClick={handleStart}
                      disabled={startAutomation.isPending}
                      className="w-full sm:w-auto h-16 px-8 text-lg font-bold tracking-widest shadow-[0_0_15px_rgba(20,180,100,0.3)] hover:shadow-[0_0_25px_rgba(20,180,100,0.5)] transition-all"
                    >
                      <Play className="mr-2 h-5 w-5 fill-current" />
                      INITIALIZE
                    </Button>
                  )}
                  
                  <div className="flex-1 grid grid-cols-2 gap-4">
                    <div className="bg-background/50 rounded-lg p-3 border border-border">
                      <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Session Yield</div>
                      <div className="text-2xl font-bold text-primary">{status?.pointsEarned || 0}</div>
                    </div>
                    <div className="bg-background/50 rounded-lg p-3 border border-border">
                      <div className="text-xs text-muted-foreground uppercase font-mono mb-1">Session Surveys</div>
                      <div className="text-2xl font-bold text-foreground">{status?.surveysCompleted || 0}</div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="col-span-1 bg-card/50 backdrop-blur-sm">
            <CardHeader className="pb-2 border-b border-border/50">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Lifetime Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 grid grid-cols-1 gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-primary" />
                  <span className="text-sm font-mono">Total Yield</span>
                </div>
                <span className="font-bold text-lg">{stats?.totalPointsEarned || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-blue-400" />
                  <span className="text-sm font-mono">Surveys Done</span>
                </div>
                <span className="font-bold text-lg">{stats?.totalSurveysCompleted || 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-purple-400" />
                  <span className="text-sm font-mono">Success Rate</span>
                </div>
                <span className="font-bold text-lg">{((stats?.successRate || 0) * 100).toFixed(1)}%</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Lower Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Live Activity Log */}
          <Card className="col-span-1 lg:col-span-1 flex flex-col h-[500px] border-border/50 shadow-none">
            <CardHeader className="py-3 px-4 border-b border-border/50 bg-muted/20">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Terminal Stream
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden bg-[#0A0A0E]">
              <ScrollArea className="h-full w-full">
                <div className="p-4 space-y-2 font-mono text-[11px] sm:text-xs">
                  {logs && logs.length > 0 ? (
                    logs.map((log) => (
                      <div key={log.id} className="flex gap-3 leading-relaxed border-b border-white/5 pb-2 last:border-0 hover:bg-white/5 p-1 rounded transition-colors">
                        <span className="text-muted-foreground/60 shrink-0 select-none">
                          {format(new Date(log.timestamp), 'HH:mm:ss')}
                        </span>
                        <div className="flex flex-col flex-1">
                          <span className={`${getLogLevelColor(log.level)}`}>
                            {log.message}
                          </span>
                          {log.detail && (
                            <span className="text-muted-foreground/70 mt-0.5 break-all">
                              {log.detail}
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-muted-foreground/50 text-center py-8 italic">
                      Awaiting system input...
                    </div>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Survey History Table */}
          <Card className="col-span-1 lg:col-span-2 flex flex-col h-[500px]">
            <CardHeader className="py-3 px-4 border-b border-border/50 bg-muted/20">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                <Database className="h-4 w-4" />
                Acquisition Ledger
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden">
              <ScrollArea className="h-full w-full">
                <div className="p-4">
                  <div className="rounded-md border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/30 border-b border-border text-xs uppercase tracking-wider text-muted-foreground font-mono">
                        <tr>
                          <th className="px-4 py-3 text-left font-medium">Designation</th>
                          <th className="px-4 py-3 text-right font-medium">Yield</th>
                          <th className="px-4 py-3 text-center font-medium">Status</th>
                          <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Duration</th>
                          <th className="px-4 py-3 text-right font-medium">Timestamp</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {surveys && surveys.length > 0 ? (
                          surveys.map((survey) => (
                            <tr key={survey.id} className="hover:bg-muted/10 transition-colors">
                              <td className="px-4 py-3 font-medium text-foreground max-w-[200px] truncate" title={survey.title}>
                                {survey.title}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-primary font-medium">
                                +{survey.points}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <Badge 
                                  variant="outline" 
                                  className={`text-[10px] uppercase font-mono ${
                                    survey.status === 'completed' ? 'border-primary/50 text-primary bg-primary/10' :
                                    survey.status === 'failed' ? 'border-destructive/50 text-destructive bg-destructive/10' :
                                    'border-yellow-500/50 text-yellow-400 bg-yellow-500/10'
                                  }`}
                                >
                                  {survey.status}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-right text-muted-foreground font-mono hidden sm:table-cell">
                                {survey.durationSeconds ? `${survey.durationSeconds}s` : '-'}
                              </td>
                              <td className="px-4 py-3 text-right text-muted-foreground font-mono text-xs">
                                {format(new Date(survey.completedAt), 'MMM dd, HH:mm')}
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                              No records found in acquisition ledger.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
          
        </div>
      </div>
    </div>
  );
}
